/**
 * Continuous-text reading (Phase 9) — read helpers.
 *
 * A registered source (one with a db.aynu.org slug) is read document by
 * document: a document is the sentence-id prefix before '#', and its
 * sentences occupy one contiguous `row_order` range. `text_documents`
 * (migrations/0007_text_documents.sql) holds that range per document so a
 * page of text is one indexed range scan. `textDocumentsRebuild()` rebuilds
 * the table from `sentences` and runs after every load; `TEXT_CONTIGUITY_SQL`
 * counts the documents whose range holds foreign rows, and a load refuses to
 * rebuild while that count is not zero.
 *
 * `text` is the active text of the corpus: the modern-orthography sidecar
 * where one is loaded (Batchelor Bible, Murasaki-notation Sakhalin texts),
 * the source transcription elsewhere. `source_text` carries the printed
 * spelling when a sidecar is active, so a reader can show both.
 *
 * While the table is absent every helper reports `ready: false` so the
 * routes can answer without caching (same grace policy as gloss.ts).
 */

export const TEXT_PAGE_LIMIT_DEFAULT = 500;
export const TEXT_PAGE_LIMIT_MAX = 1000;

export interface TextSourceSummary {
  source_slug: string;
  documents: number;
  sentences: number;
  translated: number;
  /** Sidecar id when every document of the source carries the same one. */
  text_layer: string | null;
  text_layer_status: string | null;
}

export interface TextDocument {
  key: string;
  ord: number;
  title: string | null;
  sentences: number;
  translated: number;
  text_layer: string | null;
  text_layer_status: string | null;
  /** Speaker or author when every sentence of the document agrees. */
  author: string | null;
  /** Dialect when every sentence of the document agrees. */
  dialect: string | null;
  uri: string | null;
}

export interface TextSentence {
  id: string;
  /** 0-based position within the document. */
  index: number;
  text: string;
  /** Printed spelling when `text` comes from a modern-orthography sidecar. */
  source_text: string | null;
  text_layer: string | null;
  text_layer_status: string | null;
  translation: string | null;
  dialect: string | null;
  author: string | null;
  uri: string | null;
}

export interface TextDocumentPage {
  document: TextDocument;
  prev: Pick<TextDocument, "key" | "title"> | null;
  next: Pick<TextDocument, "key" | "title"> | null;
  sentences: TextSentence[];
  total: number;
  offset: number;
  limit: number;
}

/** `ready: false` means text_documents does not exist yet. */
export type TextResult<T> = { ready: true; data: T } | { ready: false };

const UNIFORM = (col: string) =>
  `CASE WHEN count(${col}) = count(*) AND count(DISTINCT ${col}) = 1 THEN min(${col}) END`;

const REGISTERED = `source_slug IS NOT NULL AND source_slug <> '' AND instr(id, '#') > 0`;

/**
 * Documents whose row_order range holds more rows than the document has
 * sentences — the count is zero when every document is contiguous and no two
 * interleave. Run against `sentences` before a rebuild.
 */
export const TEXT_CONTIGUITY_SQL = `SELECT count(*) AS violations FROM (
     SELECT source_slug, substr(id, 1, instr(id, '#') - 1) AS key
     FROM sentences
     WHERE ${REGISTERED}
     GROUP BY source_slug, key
     HAVING max(row_order) - min(row_order) + 1 <> count(*)
   )`;

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Statements that replace text_documents from sentences: a DELETE and one
 * INSERT … SELECT, to run in one write batch. `excluded` names source slugs
 * that are not continuous text (data/text_exclusions.json).
 */
export function textDocumentsRebuild(excluded: string[] = []): string[] {
  for (const slug of excluded) {
    if (!SLUG.test(slug)) throw new Error(`text exclusion is not a slug: ${slug}`);
  }
  const exclusion = excluded.length
    ? ` AND source_slug NOT IN (${excluded.map((s) => `'${s}'`).join(", ")})`
    : "";
  return [
    "DELETE FROM text_documents",
    `INSERT INTO text_documents
       (source_slug, key, ord, title, row_start, row_end, sentences, translated, text_layer, text_layer_status, author, dialect, uri)
     SELECT source_slug, key,
            row_number() OVER (PARTITION BY source_slug ORDER BY row_start, key) - 1,
            title, row_start, row_end, n, translated, text_layer, text_layer_status, author, dialect, uri
     FROM (
       SELECT source_slug,
              substr(id, 1, instr(id, '#') - 1) AS key,
              min(document) AS title,
              min(row_order) AS row_start,
              max(row_order) AS row_end,
              count(*) AS n,
              sum(translation IS NOT NULL AND translation <> '') AS translated,
              ${UNIFORM("text_layer")} AS text_layer,
              ${UNIFORM("text_layer_status")} AS text_layer_status,
              ${UNIFORM("author")} AS author,
              ${UNIFORM("dialect")} AS dialect,
              min(uri) AS uri
       FROM sentences
       WHERE ${REGISTERED}${exclusion}
       GROUP BY source_slug, key
     )`,
  ];
}

function missingSchema(e: unknown): boolean {
  const s = String(e instanceof Error ? e.message : e);
  return /no such table: text_documents/i.test(s);
}

function clampLimit(n: number | undefined): number {
  if (n == null || !Number.isFinite(n) || n <= 0) return TEXT_PAGE_LIMIT_DEFAULT;
  return Math.min(Math.floor(n), TEXT_PAGE_LIMIT_MAX);
}

function clampOffset(n: number | undefined): number {
  if (n == null || !Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

interface DocRow {
  key: string;
  ord: number;
  title: string | null;
  row_start: number;
  row_end: number;
  sentences: number;
  translated: number;
  text_layer: string | null;
  text_layer_status: string | null;
  author: string | null;
  dialect: string | null;
  uri: string | null;
}

const DOC_COLUMNS =
  "key, ord, title, row_start, row_end, sentences, translated, text_layer, text_layer_status, author, dialect, uri";

function toDocument(r: DocRow): TextDocument {
  return {
    key: r.key,
    ord: Number(r.ord),
    title: r.title ?? null,
    sentences: Number(r.sentences),
    translated: Number(r.translated),
    text_layer: r.text_layer ?? null,
    text_layer_status: r.text_layer_status ?? null,
    author: r.author ?? null,
    dialect: r.dialect ?? null,
    uri: r.uri ?? null,
  };
}

/** Every source with readable text, with its document and sentence totals. */
export async function textSources(db: D1Database): Promise<TextResult<TextSourceSummary[]>> {
  try {
    const { results } = await db
      .prepare(
        `SELECT source_slug,
                count(*) AS documents,
                sum(sentences) AS sentences,
                sum(translated) AS translated,
                ${UNIFORM("text_layer")} AS text_layer,
                ${UNIFORM("text_layer_status")} AS text_layer_status
         FROM text_documents
         GROUP BY source_slug
         ORDER BY source_slug`,
      )
      .all<TextSourceSummary>();
    return {
      ready: true,
      data: results.map((r) => ({
        source_slug: r.source_slug,
        documents: Number(r.documents),
        sentences: Number(r.sentences),
        translated: Number(r.translated),
        text_layer: r.text_layer ?? null,
        text_layer_status: r.text_layer_status ?? null,
      })),
    };
  } catch (e) {
    if (missingSchema(e)) return { ready: false };
    throw e;
  }
}

/** The documents of one source in reading order. Empty when the source has no text. */
export async function textDocuments(db: D1Database, sourceSlug: string): Promise<TextResult<TextDocument[]>> {
  try {
    const { results } = await db
      .prepare(`SELECT ${DOC_COLUMNS} FROM text_documents WHERE source_slug = ? ORDER BY ord`)
      .bind(sourceSlug)
      .all<DocRow>();
    return { ready: true, data: results.map(toDocument) };
  } catch (e) {
    if (missingSchema(e)) return { ready: false };
    throw e;
  }
}

interface SentenceRow {
  id: string;
  text: string;
  legacy_text: string | null;
  text_layer: string | null;
  text_layer_status: string | null;
  translation: string | null;
  dialect: string | null;
  author: string | null;
  uri: string | null;
}

/**
 * One page of a document's sentences in reading order, with the neighbouring
 * documents for navigation. `data: null` when the document does not exist;
 * an offset past the end yields an empty page with the requested offset. The
 * range scan also matches the document key, so a row that strayed into the
 * range is left out rather than shown under the wrong title.
 */
export async function textDocument(
  db: D1Database,
  sourceSlug: string,
  key: string,
  opts: { offset?: number; limit?: number } = {},
): Promise<TextResult<TextDocumentPage | null>> {
  let doc: DocRow | null;
  try {
    doc = await db
      .prepare(`SELECT ${DOC_COLUMNS} FROM text_documents WHERE source_slug = ? AND key = ?`)
      .bind(sourceSlug, key)
      .first<DocRow>();
  } catch (e) {
    if (missingSchema(e)) return { ready: false };
    throw e;
  }
  if (!doc) return { ready: true, data: null };

  const limit = clampLimit(opts.limit);
  const offset = clampOffset(opts.offset);
  const total = Number(doc.sentences);
  const rowStart = Number(doc.row_start);
  const rowEnd = Number(doc.row_end);

  const [rows, neighbours] = await Promise.all([
    offset >= total
      ? Promise.resolve([] as SentenceRow[])
      : db
          .prepare(
            `SELECT id, text, legacy_text, text_layer, text_layer_status, translation, dialect, author, uri
             FROM sentences
             WHERE source_slug = ? AND row_order BETWEEN ? AND ? AND substr(id, 1, instr(id, '#') - 1) = ?
             ORDER BY row_order LIMIT ? OFFSET ?`,
          )
          .bind(sourceSlug, rowStart, rowEnd, key, limit, offset)
          .all<SentenceRow>()
          .then((r) => r.results),
    db
      .prepare(`SELECT key, ord, title FROM text_documents WHERE source_slug = ? AND ord IN (?, ?) ORDER BY ord`)
      .bind(sourceSlug, Number(doc.ord) - 1, Number(doc.ord) + 1)
      .all<{ key: string; ord: number; title: string | null }>()
      .then((r) => r.results),
  ]);

  const prevRow = neighbours.find((n) => Number(n.ord) === Number(doc.ord) - 1) ?? null;
  const nextRow = neighbours.find((n) => Number(n.ord) === Number(doc.ord) + 1) ?? null;

  return {
    ready: true,
    data: {
      document: toDocument(doc),
      prev: prevRow ? { key: prevRow.key, title: prevRow.title ?? null } : null,
      next: nextRow ? { key: nextRow.key, title: nextRow.title ?? null } : null,
      sentences: rows.map((r, i) => ({
        id: r.id,
        index: offset + i,
        text: r.text,
        source_text: r.legacy_text ?? null,
        text_layer: r.text_layer ?? null,
        text_layer_status: r.text_layer_status ?? null,
        translation: r.translation && r.translation !== "" ? r.translation : null,
        dialect: r.dialect ?? null,
        author: r.author ?? null,
        uri: r.uri ?? null,
      })),
      total,
      offset,
      limit,
    },
  };
}
