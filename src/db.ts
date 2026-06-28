/**
 * Corpus query helpers for the Turso (libSQL) reference store.
 *
 * Lifted verbatim from ainu-mcp/worker/src/db.ts (corpus-relevant subset only:
 * corpus search, stats/meta, token frequency, stopwords, vocab candidates).
 * Behaviour MUST stay byte-identical so the MCP extraction is a pure refactor
 * — the golden parity tests assert this.
 *
 * Every substring search reproduces the original Python `q in text.lower()`
 * semantics using FTS5 + the trigram tokenizer (case-insensitive, substring,
 * CJK-safe). Trigram indexes need >=3 characters; shorter queries fall back to a
 * bounded LIKE scan.
 */

/** Wrap a user string as an FTS5 phrase (quote, and escape internal quotes). */
function ftsPhrase(q: string): string {
  return '"' + q.replace(/"/g, '""') + '"';
}

/** Escape `%` and `_` for a LIKE substring pattern (ESCAPE '\'). */
function likePattern(q: string): string {
  return "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
}

/** Clamp a caller `limit` to a non-negative integer. Guards against a negative
 * value becoming SQLite `LIMIT -1` (= unbounded → a full-table read). */
function clampLimit(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export interface CorpusRow {
  id: string;
  text: string;
  translation: string;
  dialect: string | null;
  author: string | null;
  collection: string | null;
  document: string | null;
  uri: string | null;
}

export type CorpusLang = "ain" | "jpn" | "any";

export async function corpusSearch(
  db: D1Database,
  opts: { query: string; lang: CorpusLang; dialect?: string | null; author?: string | null; limit: number },
): Promise<CorpusRow[]> {
  const q = opts.query.trim();
  if (!q) return [];
  const select = `SELECT id, text, translation, dialect, author, collection, document, uri FROM corpus_fts`;
  const params: unknown[] = [];
  let where: string;

  if (q.length >= 3) {
    const col = opts.lang === "ain" ? "text" : opts.lang === "jpn" ? "translation" : null;
    const match = col ? `${col} : ${ftsPhrase(q)}` : ftsPhrase(q);
    where = ` WHERE corpus_fts MATCH ?`;
    params.push(match);
  } else {
    // <3 chars: trigram can't index — bounded LIKE scan in rowid order.
    const pat = likePattern(q.toLowerCase());
    if (opts.lang === "ain") {
      where = ` WHERE lower(text) LIKE ? ESCAPE '\\'`;
      params.push(pat);
    } else if (opts.lang === "jpn") {
      where = ` WHERE lower(translation) LIKE ? ESCAPE '\\'`;
      params.push(pat);
    } else {
      where = ` WHERE (lower(text) LIKE ? ESCAPE '\\' OR lower(translation) LIKE ? ESCAPE '\\')`;
      params.push(pat, pat);
    }
  }
  if (opts.dialect) {
    where += ` AND instr(dialect, ?) > 0`;
    params.push(opts.dialect);
  }
  if (opts.author) {
    where += ` AND instr(author, ?) > 0`;
    params.push(opts.author);
  }
  const sql = `${select}${where} ORDER BY rowid LIMIT ?`;
  params.push(clampLimit(opts.limit));
  const { results } = await db.prepare(sql).bind(...params).all<CorpusRow>();
  return results ?? [];
}

export async function getMeta(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare(`SELECT value FROM meta WHERE key = ?`).bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

// ───────────────────────────── Frequency + stopwords ───────────────────────────── //

export interface TokenFreqRow {
  token: string;
  count: number;
  is_stopword: number;
}

/** Frequency row for one normalized token, plus its 1-based rank among all
 * distinct tokens. Returns null when the token never appears in the corpus. */
export async function tokenFrequency(
  db: D1Database,
  normalized: string,
): Promise<{ count: number; is_stopword: boolean; rank: number } | null> {
  if (!normalized) return null;
  const row = await db
    .prepare(`SELECT count, is_stopword FROM token_freq WHERE token = ?`)
    .bind(normalized)
    .first<{ count: number; is_stopword: number }>();
  if (!row) return null;
  const higher = await db
    .prepare(`SELECT count(*) AS c FROM token_freq WHERE count > ?`)
    .bind(row.count)
    .first<{ c: number }>();
  return { count: row.count, is_stopword: row.is_stopword === 1, rank: (higher?.c ?? 0) + 1 };
}

/** Most-frequent tokens, descending by count (ties by first-appearance rowid).
 * Optionally drops stopwords before paging. */
export async function frequencyList(
  db: D1Database,
  opts: { limit: number; offset: number; includeStopwords: boolean; minCount: number },
): Promise<TokenFreqRow[]> {
  const where = opts.includeStopwords ? `count >= ?` : `count >= ? AND is_stopword = 0`;
  const offset = Number.isFinite(opts.offset) && opts.offset > 0 ? Math.floor(opts.offset) : 0;
  const { results } = await db
    .prepare(
      `SELECT token, count, is_stopword FROM token_freq WHERE ${where} ORDER BY count DESC, rowid LIMIT ? OFFSET ?`,
    )
    .bind(opts.minCount, clampLimit(opts.limit), offset)
    .all<TokenFreqRow>();
  return results ?? [];
}

/** The canonical stopword list (published forms), in source order. */
export async function stopwordsList(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare(`SELECT word FROM stopwords ORDER BY rowid`).all<{ word: string }>();
  return (results ?? []).map((r) => r.word);
}

/** Whether a normalized word is a stopword (matches the normalized column). */
export async function isStopword(db: D1Database, normalized: string): Promise<boolean> {
  if (!normalized) return false;
  const row = await db.prepare(`SELECT 1 AS x FROM stopwords WHERE normalized = ? LIMIT 1`).bind(normalized).first<{ x: number }>();
  return row != null;
}

export interface VocabCandidate {
  token: string;
  count: number;
  attested_in: string; // JSON array
  sample_text: string | null;
  sample_translation: string | null;
}

/** Raw corpus vocab-gap candidates (count >= minCount), descending by count.
 * NOTE: this is the RAW corpus side only. The live glossary subtraction that
 * the old MCP `glossary_missing_high_frequency` tool performed (Google Sheets)
 * stays in the MCP — the corpus API has no Sheets credentials by design. */
export async function vocabCandidates(db: D1Database, minCount: number): Promise<VocabCandidate[]> {
  const { results } = await db
    .prepare(`SELECT token, count, attested_in, sample_text, sample_translation FROM vocab_candidates WHERE count >= ? ORDER BY count DESC, rowid`)
    .bind(minCount)
    .all<VocabCandidate>();
  return results ?? [];
}
