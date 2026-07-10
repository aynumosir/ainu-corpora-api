/**
 * Annotated KWIC + inflection-aware concordance (Phase 4).
 *
 * This is the richer sibling of tokens.ts `concordance()`. Where that returns
 * pre-sliced left/node/right STRINGS, this returns TOKEN ARRAYS so the frontend
 * can: show POS/gloss under each token, make every word clickable (search-on-
 * click), sort by the Nth token left/right of the node, and fold pitch accents.
 *
 * It also understands the Ainu morphology layer (morph_forms): `expand=plural`
 * folds a verb together with its suppletive/‑pa plural, so one search over
 * `arpa` can also surface `paye`.
 */
import { foldToken, normToken, isGlottalMarker } from "./normalize.js";
import { dialectWhere, type DialectFilter } from "./dialect.js";
import { sourceSlugsFor } from "./db.js";
import { regexNodeKeys } from "./regex.js";

function clampLimit(n: number, max = 500): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), max);
}
function likeEscape(q: string): string {
  return q.replace(/[\\%_]/g, (c) => "\\" + c);
}
function missingSchema(e: unknown): boolean {
  const s = String(e instanceof Error ? e.message : e);
  return /no such column:.*(surface_fold|region|dialect_path|alternates)|no such table: (morph_forms|morph_gloss)/i.test(s);
}

/** A single token in a KWIC line (compact keys keep the JSON small). */
export interface KwicToken {
  i: number;            // idx within the sentence
  s: string;            // surface (as printed)
  n: string;            // surface_norm
  p: string | null;     // display POS (morph_gloss.pos_display ?? upos), e.g. PERS
  u?: string | null;    // raw tagger UPOS
  l: string | null;     // lemma
  x: string | null;     // xpos (fine tag)
  f: string | null;     // feats (morph features string)
  g?: string | null;    // short English gloss from morpheme-database
  mc?: string | null;   // morpheme DB category (pers/vt/n/sfx/...)
  cl: number;           // 1 if clitic (ku= / =an …)
  node?: boolean;       // true on the matched node token(s)
  alt?: KwicGlossAlt[]; // other homograph readings of this surface (pa: head → PL/mouth)
}

/** An alternate (non-displayed) reading of a homographous surface form. */
export interface KwicGlossAlt {
  p: string | null;     // display POS of the alternate reading
  g: string;            // its gloss
  mc: string | null;    // its morpheme DB category
}

export interface KwicLine {
  sentence_id: string;
  left: KwicToken[];
  node: KwicToken[];
  right: KwicToken[];
  // Char-string slices too, for callers that just want the classic grid.
  left_text: string;
  node_text: string;
  right_text: string;
  translation: string | null;
  dialect: string | null;
  author: string | null;
  uri: string | null;
  source_slug: string | null; // db.aynu.org source-record slug (see migrations/0005)
}

export type NodeSort =
  | "none" | "left" | "right"
  | "l1" | "l2" | "l3" | "r1" | "r2" | "r3"
  | "node" | "dialect" | "author";
export type KwicMatch = "fold" | "exact" | "prefix" | "regex";

interface RawTok {
  sentence_id: string;
  idx: number;
  surface: string;
  surface_norm: string;
  upos: string | null;
  lemma: string | null;
  xpos: string | null;
  feats_json: string | null;
  is_clitic: number;
  pos_display?: string | null;
  gloss_en?: string | null;
  morph_category?: string | null;
  alternates?: string | null;
}

const parseAlt = (s: string | null | undefined): KwicGlossAlt[] | undefined => {
  if (!s) return undefined;
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) && a.length ? a : undefined;
  } catch { return undefined; }
};

const toTok = (r: RawTok): KwicToken => ({
  i: r.idx, s: r.surface, n: r.surface_norm, p: r.pos_display ?? r.upos, u: r.upos, l: r.lemma,
  x: r.xpos, f: r.feats_json, g: r.gloss_en ?? null, mc: r.morph_category ?? null, cl: r.is_clitic ? 1 : 0,
  alt: parseAlt(r.alternates),
});

/** Resolve the set of folded node keys to match, expanding via morph_forms. */
async function resolveNodeKeys(
  db: D1Database,
  q: string,
  expand: "none" | "plural" | "all",
  useFold: boolean,
): Promise<string[]> {
  const base = useFold ? foldToken(q.trim()) : normToken(q.trim());
  if (!base) return [];
  const keys = new Set<string>([base]);
  if (useFold && expand !== "none") {
    const rel = expand === "plural" ? " AND relation = 'plural'" : "";
    try {
      // A query word may be either a lemma or an inflected surface — pull both directions.
      const { results } = await db
        .prepare(
          `SELECT lemma_fold, surface_fold FROM morph_forms
           WHERE (lemma_fold = ? OR surface_fold = ?)${rel}`,
        )
        .bind(base, base)
        .all<{ lemma_fold: string; surface_fold: string }>();
      for (const r of results ?? []) {
        if (r.lemma_fold) keys.add(r.lemma_fold);
        if (r.surface_fold) keys.add(r.surface_fold);
      }
    } catch (e) {
      if (!missingSchema(e)) throw e;
      // Production DB may be one migration behind during deploy; fall back to the base key.
    }
  }
  return [...keys];
}

/**
 * Annotated KWIC. Finds node tokens (by folded key by default), then loads the
 * full token rows of the matched sentences and builds per-token windows.
 */
export async function kwic(
  db: D1Database,
  opts: {
    q: string;
    ctx: number;                 // context tokens each side
    limit: number;
    offset?: number;             // pagination offset (corpus order)
    sort: NodeSort;
    match: KwicMatch;
    expand: "none" | "plural" | "all";
    nodeUpos?: string | null;    // constrain the node's POS
    clitic?: "any" | "only" | "exclude";
    dialect?: string | null;
    region?: string | null;
    dialectPath?: string | null;
    author?: string | null;
  },
): Promise<KwicLine[]> {
  try {
    return await kwicImpl(db, opts, true);
  } catch (e) {
    if (!missingSchema(e)) throw e;
    return await kwicImpl(db, opts, false);
  }
}

/** Build the node-selection WHERE (match + upos + clitic + dialect + author) and
 * its bound params, shared by the KWIC fetch and the total-count query so they
 * can never drift. Returns null when a fold/expand match resolves to no keys. */
async function buildNodeWhere(
  db: D1Database,
  opts: Parameters<typeof kwic>[1],
  useFold: boolean,
): Promise<{ where: string; params: unknown[] } | null> {
  const q = opts.q.trim();
  if (!q) return null;
  const keyCol = useFold ? "surface_fold" : "surface_norm";
  const params: unknown[] = [];
  let nodeWhere: string;
  if (opts.match === "regex") {
    // Word regex (/ech?i/): resolved in the Worker against the distinct vocab,
    // then matched as a key set like fold/expand. Throws BadRegexError → 400.
    const keys = await regexNodeKeys(db, q, keyCol);
    if (!keys.length) return null;
    nodeWhere = `t.${keyCol} IN (${keys.map(() => "?").join(",")})`;
    params.push(...keys);
  } else if (opts.match === "prefix") {
    nodeWhere = `t.${keyCol} LIKE ? ESCAPE '\\'`;
    params.push(likeEscape(useFold ? foldToken(q) : normToken(q)) + "%");
  } else if (opts.match === "exact") {
    nodeWhere = "t.surface_norm = ?";
    params.push(normToken(q));
  } else {
    const keys = await resolveNodeKeys(db, q, opts.expand, useFold);
    if (!keys.length) return null;
    nodeWhere = `t.${keyCol} IN (${keys.map(() => "?").join(",")})`;
    params.push(...keys);
  }
  if (opts.nodeUpos) { nodeWhere += " AND t.upos = ?"; params.push(opts.nodeUpos.toUpperCase()); }
  if (opts.clitic === "only") nodeWhere += " AND t.is_clitic = 1";
  else if (opts.clitic === "exclude") nodeWhere += " AND t.is_clitic = 0";
  // In the degraded (pre-Phase-5) path the region/dialect_path columns don't
  // exist, so fall back to the legacy free-text dialect filter only.
  const dw = useFold
    ? dialectWhere("s", opts as DialectFilter)
    : dialectWhere("s", { dialect: opts.dialect ?? null });
  nodeWhere += dw.sql; params.push(...dw.params);
  if (opts.author) { nodeWhere += " AND instr(s.author, ?) > 0"; params.push(opts.author); }
  return { where: nodeWhere, params };
}

/** Total number of matching node tokens (ignores limit/offset) for pagination.
 * Mirrors kwic()'s fold→non-fold schema fallback. One COUNT round-trip. */
export async function kwicTotal(db: D1Database, opts: Parameters<typeof kwic>[1]): Promise<number> {
  const count = async (useFold: boolean): Promise<number> => {
    const built = await buildNodeWhere(db, opts, useFold);
    if (!built) return 0;
    const row = await db
      .prepare(`SELECT count(*) AS c FROM corpus_tokens t JOIN sentences s ON s.id = t.sentence_id WHERE ${built.where}`)
      .bind(...built.params)
      .first<{ c: number }>();
    return row?.c ?? 0;
  };
  try {
    return await count(true);
  } catch (e) {
    if (!missingSchema(e)) throw e;
    return await count(false);
  }
}

async function kwicImpl(
  db: D1Database,
  opts: Parameters<typeof kwic>[1],
  useFold: boolean,
): Promise<KwicLine[]> {
  const built = await buildNodeWhere(db, opts, useFold);
  if (!built) return [];
  const { where: nodeWhere, params } = built;

  const lim = clampLimit(opts.limit);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const sql = `SELECT t.sentence_id, t.idx, t.char_start, t.char_end,
                      s.text, s.translation, s.dialect, s.author, s.uri
               FROM corpus_tokens t JOIN sentences s ON s.id = t.sentence_id
               WHERE ${nodeWhere}
               ORDER BY t.sentence_id, t.idx
               LIMIT ? OFFSET ?`;
  params.push(lim, offset);
  const { results: nodes } = await db.prepare(sql).bind(...params).all<{
    sentence_id: string; idx: number; char_start: number; char_end: number;
    text: string; translation: string | null; dialect: string | null;
    author: string | null; uri: string | null;
  }>();
  if (!nodes?.length) return [];

  // Load all token rows for the matched sentences (sentences are short).
  const sentIds = [...new Set(nodes.map((n) => n.sentence_id))];
  const tokById = new Map<string, RawTok[]>();
  let canJoinGloss = true;
  // Chunk the IN-list so we never blow the SQLite variable limit.
  for (let i = 0; i < sentIds.length; i += 200) {
    const slice = sentIds.slice(i, i + 200);
    let results: RawTok[] | undefined;
    if (canJoinGloss) {
      try {
        ({ results } = await db
          .prepare(
            `SELECT t.sentence_id, t.idx, t.surface, t.surface_norm, t.upos, t.lemma, t.xpos, t.feats_json, t.is_clitic,
                    mg.pos_display, mg.gloss_en, mg.category AS morph_category, mg.alternates
             FROM corpus_tokens t
             LEFT JOIN morph_gloss mg ON mg.key_fold = t.surface_fold
             WHERE t.sentence_id IN (${slice.map(() => "?").join(",")})
             ORDER BY t.sentence_id, t.idx`,
          )
          .bind(...slice)
          .all<RawTok>());
      } catch (e) {
        if (!missingSchema(e)) throw e;
        canJoinGloss = false;
      }
    }
    if (!canJoinGloss) {
      ({ results } = await db
        .prepare(
          `SELECT sentence_id, idx, surface, surface_norm, upos, lemma, xpos, feats_json, is_clitic
           FROM corpus_tokens WHERE sentence_id IN (${slice.map(() => "?").join(",")})
           ORDER BY sentence_id, idx`,
        )
        .bind(...slice)
        .all<RawTok>());
    }
    for (const r of results ?? []) {
      let arr = tokById.get(r.sentence_id);
      if (!arr) tokById.set(r.sentence_id, (arr = []));
      arr.push(r);
    }
  }

  // db.aynu.org source links (empty map when the column is absent — degrade).
  const slugs = await sourceSlugsFor(db, sentIds);

  const ctx = Math.max(0, Math.floor(opts.ctx));
  const sentText = new Map<string, string>();
  for (const n of nodes) sentText.set(n.sentence_id, n.text);

  const lines: KwicLine[] = nodes.map((n) => {
    const allToks = tokById.get(n.sentence_id) ?? [];
    // Locate the node in the FULL token list (offsets must stay aligned)…
    const pos = allToks.findIndex((t) => t.idx === n.idx);
    const at = pos < 0 ? 0 : pos;
    // …then build context from a view that drops standalone glottal-stop
    // markers (the apostrophe "tokens" in the Murasaki Sakhalin texts), which
    // are orthographic noise and otherwise fill the KWIC window with " ' ' ".
    // The node token itself is always kept, even if it were a marker.
    const left: KwicToken[] = [];
    for (let j = at - 1; j >= 0 && left.length < ctx; j--) {
      if (isGlottalMarker(allToks[j].surface)) continue;
      left.unshift(toTok(allToks[j]));
    }
    const nodeToks = [toTok(allToks[at] ?? ({} as RawTok))];
    nodeToks[0].node = true;
    const right: KwicToken[] = [];
    for (let j = at + 1; j < allToks.length && right.length < ctx; j++) {
      if (isGlottalMarker(allToks[j].surface)) continue;
      right.push(toTok(allToks[j]));
    }
    const text = n.text ?? "";
    return {
      sentence_id: n.sentence_id,
      left, node: nodeToks, right,
      left_text: text.slice(Math.max(0, n.char_start - 48), n.char_start),
      node_text: text.slice(n.char_start, n.char_end),
      right_text: text.slice(n.char_end, n.char_end + 48),
      translation: n.translation, dialect: n.dialect, author: n.author, uri: n.uri,
      source_slug: slugs.get(n.sentence_id) ?? null,
    };
  });

  sortLines(lines, opts.sort);
  return lines;
}

/** Surface of the Nth token left (1 = nearest the node) or "" if none. */
const leftN = (l: KwicLine, n: number) => l.left[l.left.length - n]?.n ?? "";
const rightN = (l: KwicLine, n: number) => l.right[n - 1]?.n ?? "";

export function sortLines(lines: KwicLine[], sort: NodeSort): void {
  const cmp = (a: string, b: string) => a.localeCompare(b);
  switch (sort) {
    case "left": // outward from node: reversed left context string
      lines.sort((x, y) =>
        cmp([...x.left].reverse().map((t) => t.n).join(" "), [...y.left].reverse().map((t) => t.n).join(" ")));
      break;
    case "right":
      lines.sort((x, y) => cmp(x.right.map((t) => t.n).join(" "), y.right.map((t) => t.n).join(" ")));
      break;
    case "l1": lines.sort((x, y) => cmp(leftN(x, 1), leftN(y, 1))); break;
    case "l2": lines.sort((x, y) => cmp(leftN(x, 2), leftN(y, 2))); break;
    case "l3": lines.sort((x, y) => cmp(leftN(x, 3), leftN(y, 3))); break;
    case "r1": lines.sort((x, y) => cmp(rightN(x, 1), rightN(y, 1))); break;
    case "r2": lines.sort((x, y) => cmp(rightN(x, 2), rightN(y, 2))); break;
    case "r3": lines.sort((x, y) => cmp(rightN(x, 3), rightN(y, 3))); break;
    case "node": lines.sort((x, y) => cmp(x.node_text.toLowerCase(), y.node_text.toLowerCase())); break;
    case "dialect": lines.sort((x, y) => cmp(x.dialect ?? "", y.dialect ?? "")); break;
    case "author": lines.sort((x, y) => cmp(x.author ?? "", y.author ?? "")); break;
    case "none": default: break;
  }
}

/** Inflection lookup for the UI's "inflection chooser" / singular↔plural toggle. */
export async function inflections(
  db: D1Database,
  word: string,
): Promise<{
  query: string;
  fold: string;
  forms: { lemma: string; surface: string; relation: string; number_locus: string | null; form_length: string | null; source: string | null; confidence: number | null; rule_id: string | null }[];
}> {
  const fold = foldToken(word.trim());
  if (!fold) return { query: word, fold, forms: [] };
  try {
    const { results } = await db
      .prepare(
        `SELECT lemma, surface, relation, number_locus, form_length, source, confidence, rule_id
         FROM morph_forms WHERE lemma_fold = ? OR surface_fold = ?
         ORDER BY relation, confidence DESC`,
      )
      .bind(fold, fold)
      .all<{ lemma: string; surface: string; relation: string; number_locus: string | null; form_length: string | null; source: string | null; confidence: number | null; rule_id: string | null }>();
    return { query: word, fold, forms: results ?? [] };
  } catch (e) {
    if (!missingSchema(e)) throw e;
    return { query: word, fold, forms: [] };
  }
}
