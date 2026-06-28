/**
 * Token-layer queries: KWIC concordance (Phase 2) and POS-search (Phase 3),
 * over the `corpus_tokens` + `sentences` tables (migrations/0001_tokens.sql).
 *
 * Tokens were produced by the ainu-morpheme-tagger spaCy `ain` tokenizer, so
 * the personal clitics `ku=`/`a=`/`=an` are their own tokens — which is what
 * makes adjacency queries ("VERB followed by =an") meaningful.
 */

function clampLimit(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
function likeEscape(q: string): string {
  return q.replace(/[\\%_]/g, (c) => "\\" + c);
}
/** Reverse a string for left-context (sort by the chars nearest the node, outward). */
function rev(s: string): string {
  return [...s].reverse().join("");
}

export interface ConcordanceLine {
  sentence_id: string;
  left: string;
  node: string;
  right: string;
  translation: string | null;
  dialect: string | null;
  author: string | null;
  uri: string | null;
}

export type SortMode = "none" | "left" | "right";
export type MatchMode = "exact" | "prefix";

interface TokRow {
  sentence_id: string;
  text: string;
  translation: string | null;
  dialect: string | null;
  author: string | null;
  uri: string | null;
  a: number;
  b: number;
}

/**
 * KWIC concordance for a node word. Matches `surface_norm` (normalized: lower,
 * surrounding apostrophes stripped) exactly or as a prefix, joins to the source
 * sentence, and returns left/node/right windows sliced by char offset.
 *
 * Context sort (left/right) is applied within the returned page — fine for v1;
 * a frequent node should be narrowed by dialect/author rather than fully sorted.
 */
export async function concordance(
  db: D1Database,
  opts: {
    q: string;
    window: number;
    limit: number;
    sort: SortMode;
    match: MatchMode;
    dialect?: string | null;
    author?: string | null;
  },
): Promise<ConcordanceLine[]> {
  const q = opts.q.trim().toLowerCase();
  if (!q) return [];
  const params: unknown[] = [];
  let where: string;
  if (opts.match === "prefix") {
    where = "t.surface_norm LIKE ? ESCAPE '\\'";
    params.push(likeEscape(q) + "%");
  } else {
    where = "t.surface_norm = ?";
    params.push(q);
  }
  if (opts.dialect) {
    where += " AND instr(s.dialect, ?) > 0";
    params.push(opts.dialect);
  }
  if (opts.author) {
    where += " AND instr(s.author, ?) > 0";
    params.push(opts.author);
  }
  const sql = `SELECT t.sentence_id, s.text, s.translation, s.dialect, s.author, s.uri,
                      t.char_start AS a, t.char_end AS b
               FROM corpus_tokens t JOIN sentences s ON s.id = t.sentence_id
               WHERE ${where}
               ORDER BY t.sentence_id, t.idx
               LIMIT ?`;
  params.push(clampLimit(opts.limit));
  const { results } = await db.prepare(sql).bind(...params).all<TokRow>();

  const w = Math.max(0, Math.floor(opts.window));
  const lines: ConcordanceLine[] = (results ?? []).map((r) => {
    const text = r.text ?? "";
    return {
      sentence_id: r.sentence_id,
      left: text.slice(Math.max(0, r.a - w), r.a),
      node: text.slice(r.a, r.b),
      right: text.slice(r.b, r.b + w),
      translation: r.translation,
      dialect: r.dialect,
      author: r.author,
      uri: r.uri,
    };
  });

  if (opts.sort === "left") lines.sort((x, y) => rev(x.left).localeCompare(rev(y.left)));
  else if (opts.sort === "right") lines.sort((x, y) => x.right.localeCompare(y.right));
  return lines;
}
