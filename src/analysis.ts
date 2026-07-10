/**
 * Linguistic-discovery endpoints (Phase 4): collocation, structural (sequence)
 * search, and basic analytics. All over the same `corpus_tokens` + `sentences`
 * tables; no extra build step.
 */
import { foldToken, normToken } from "./normalize.js";
import { dialectWhere, type DialectFilter } from "./dialect.js";
import { regexNodeKeys } from "./regex.js";

function clampLimit(n: number, max = 500): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), max);
}
function likeEscape(q: string): string {
  return q.replace(/[\\%_]/g, (c) => "\\" + c);
}
function missingFoldColumn(e: unknown): boolean {
  return /no such column:.*(surface_fold|region|dialect_path)/i.test(String(e instanceof Error ? e.message : e));
}

// ───────────────────────────── Collocation ───────────────────────────── //

export interface Collocate {
  token: string;
  upos: string | null;
  freq: number;        // co-occurrences in the window
  total: number;       // collocate's total corpus frequency
  log_dice: number;    // logDice association (Rychlý 2008) — window-independent scale
  t_score: number;     // t-score (favours frequent collocations)
  mi: number;          // pointwise mutual information (favours rare/strong pairs)
}

/**
 * Collocation: for a node word, the tokens that co-occur within ±window token
 * positions, scored by logDice / t-score / MI. Restricted to a span side via
 * `span` (left|right|both). Stopword-ish punctuation is dropped by default.
 */
export async function collocations(
  db: D1Database,
  opts: {
    q: string;
    window: number;       // ± token positions
    span: "both" | "left" | "right";
    minCount: number;
    limit: number;
    measure: "log_dice" | "t_score" | "mi";
    dialect?: string | null;
    region?: string | null;
    dialectPath?: string | null;
    author?: string | null;
  },
): Promise<{ node: string; node_freq: number; corpus_tokens: number; collocates: Collocate[] }> {
  try {
    return await collocationsImpl(db, opts, true);
  } catch (e) {
    if (!missingFoldColumn(e)) throw e;
    return await collocationsImpl(db, opts, false);
  }
}

async function collocationsImpl(
  db: D1Database,
  opts: Parameters<typeof collocations>[1],
  useFold: boolean,
): Promise<{ node: string; node_freq: number; corpus_tokens: number; collocates: Collocate[] }> {
  const fold = useFold ? foldToken(opts.q.trim()) : normToken(opts.q.trim());
  if (!fold) return { node: opts.q, node_freq: 0, corpus_tokens: 0, collocates: [] };
  const keyCol = useFold ? "surface_fold" : "surface_norm";
  const w = Math.max(1, Math.min(Math.floor(opts.window), 10));

  // Corpus size (token total) for MI/expected counts.
  const totalRow = await db.prepare(`SELECT count(*) AS c FROM corpus_tokens`).first<{ c: number }>();
  const N = totalRow?.c ?? 0;

  // Node occurrences (with optional dialect/author filter via the sentence join).
  const np: unknown[] = [fold];
  let nodeFilter = `t.${keyCol} = ?`;
  let join = "";
  const df = useFold ? (opts as DialectFilter) : { dialect: opts.dialect ?? null };
  const dwNode = dialectWhere("s", df);
  if (dwNode.sql || opts.author) {
    join = "JOIN sentences s ON s.id = t.sentence_id";
    nodeFilter += dwNode.sql; np.push(...dwNode.params);
    if (opts.author) { nodeFilter += " AND instr(s.author, ?) > 0"; np.push(opts.author); }
  }
  const nodeRows = await db
    .prepare(`SELECT t.sentence_id, t.idx FROM corpus_tokens t ${join} WHERE ${nodeFilter}`)
    .bind(...np)
    .all<{ sentence_id: string; idx: number }>();
  const nodeFreq = nodeRows.results?.length ?? 0;
  if (!nodeFreq) return { node: opts.q, node_freq: 0, corpus_tokens: N, collocates: [] };

  // Window self-join: collect neighbour tokens within ±w, excluding the node slot.
  const lo = opts.span === "right" ? "1" : `-${w}`;
  const hi = opts.span === "left" ? "-1" : `${w}`;
  const cp: unknown[] = [fold];
  let cjoin = "";
  let cfilter = `t.${keyCol} = ?`;
  const dwCol = dialectWhere("s", df);
  if (dwCol.sql || opts.author) {
    cjoin = "JOIN sentences s ON s.id = t.sentence_id";
    cfilter += dwCol.sql; cp.push(...dwCol.params);
    if (opts.author) { cfilter += " AND instr(s.author, ?) > 0"; cp.push(opts.author); }
  }
  const colSql = `
    SELECT c.surface_norm AS token, c.upos AS upos, count(*) AS freq
    FROM corpus_tokens t
    ${cjoin}
    JOIN corpus_tokens c
      ON c.sentence_id = t.sentence_id
     AND c.idx <> t.idx
     AND c.idx BETWEEN t.idx + (${lo}) AND t.idx + (${hi})
    WHERE ${cfilter}
      AND c.surface_norm <> ''
      AND c.upos IS NOT 'PUNCT'
    GROUP BY c.${keyCol}
    HAVING freq >= ?
    ORDER BY freq DESC
    LIMIT ?`;
  cp.push(Math.max(1, Math.floor(opts.minCount)));
  cp.push(clampLimit(opts.limit) || 50);
  const { results } = await db.prepare(colSql).bind(...cp).all<{ token: string; upos: string | null; freq: number }>();
  const cands = results ?? [];
  if (!cands.length) return { node: opts.q, node_freq: nodeFreq, corpus_tokens: N, collocates: [] };

  // Total corpus frequency of each collocate (one batched query).
  const folds = cands.map((c) => useFold ? foldToken(c.token) : normToken(c.token));
  const totals = new Map<string, number>();
  for (let i = 0; i < folds.length; i += 200) {
    const slice = folds.slice(i, i + 200);
    const { results: tr } = await db
      .prepare(`SELECT ${keyCol} AS f, count(*) AS c FROM corpus_tokens WHERE ${keyCol} IN (${slice.map(() => "?").join(",")}) GROUP BY ${keyCol}`)
      .bind(...slice)
      .all<{ f: string; c: number }>();
    for (const r of tr ?? []) totals.set(r.f, r.c);
  }

  const spanSize = opts.span === "both" ? 2 * w : w;
  const out: Collocate[] = cands.map((c) => {
    const f = useFold ? foldToken(c.token) : normToken(c.token);
    const fCollTotal = totals.get(f) ?? c.freq;
    const o11 = c.freq;                       // observed co-occurrences
    const f1 = nodeFreq * spanSize;           // node window slots
    const f2 = fCollTotal;                    // collocate total
    const expected = (f1 * f2) / Math.max(1, N);
    const logDice = 14 + Math.log2((2 * o11) / Math.max(1, f1 + f2));
    const tScore = (o11 - expected) / Math.sqrt(Math.max(1, o11));
    const mi = Math.log2(o11 / Math.max(1e-9, expected));
    return {
      token: c.token, upos: c.upos, freq: o11, total: fCollTotal,
      log_dice: round(logDice), t_score: round(tScore), mi: round(mi),
    };
  });
  out.sort((a, b) => b[opts.measure] - a[opts.measure]);
  return { node: opts.q, node_freq: nodeFreq, corpus_tokens: N, collocates: out };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ───────────────────────────── Structural (sequence) search ───────────────────────────── //

/**
 * One position in a structural pattern. Each constraint is ANDed; a position
 * with no constraints matches any token (a wildcard). Parsed from a compact
 * CQL-lite syntax in parsePattern().
 */
export interface PatternPos {
  surface?: string | null;  // folded surface match
  upos?: string | null;
  lemma?: string | null;
  prefix?: string | null;   // folded surface prefix
  regex?: string | null;    // word regex over the folded key (unanchored, case-insensitive)
}

/**
 * Parse a CQL-lite pattern into positions. Syntax (space-separated tokens):
 *   [upos=VERB]            POS constraint
 *   [surface=arpa]         exact folded surface
 *   [lemma=arpa]
 *   [surface=ku.*]         trailing .* → prefix
 *   [upos=NOUN & surface=..]  multiple constraints, & separated
 *   []                     any token (wildcard)
 *   arpa                   bare word → [surface=arpa]
 *   VERB                   bare ALLCAPS → [upos=VERB]
 *   /ech?i/                word regex (also [surface=/ech?i/]) — unanchored,
 *                          case-insensitive, over the folded key (see regex.ts)
 */
export function parsePattern(src: string): PatternPos[] {
  const positions: PatternPos[] = [];
  // Split on bracket groups OR bare words.
  const re = /\[([^\]]*)\]|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[2] != null) {
      const w = m[2];
      const rx = w.match(/^\/(.+)\/$/);
      if (rx) positions.push({ regex: rx[1] });
      else if (/^[A-Z]+$/.test(w)) positions.push({ upos: w });
      else positions.push({ surface: foldToken(w) });
      continue;
    }
    const body = (m[1] ?? "").trim();
    if (!body) { positions.push({}); continue; }
    const pos: PatternPos = {};
    for (const clause of body.split("&")) {
      const eq = clause.indexOf("=");
      if (eq < 0) {
        const t = clause.trim();
        if (/^[A-Z]+$/.test(t)) pos.upos = t;
        else if (t) pos.surface = foldToken(t);
        continue;
      }
      const key = clause.slice(0, eq).trim().toLowerCase();
      let val = clause.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key === "upos" || key === "pos") pos.upos = val.toUpperCase();
      else if (key === "lemma") pos.lemma = val;
      else if (key === "surface" || key === "word") {
        const rx = val.match(/^\/(.+)\/$/);
        if (rx) pos.regex = rx[1];
        else if (val.endsWith(".*")) pos.prefix = foldToken(val.slice(0, -2));
        else pos.surface = foldToken(val);
      }
    }
    positions.push(pos);
  }
  return positions;
}

export interface StructuralLine {
  sentence_id: string;
  match: { i: number; s: string; n: string; p: string | null; l: string | null }[];
  match_text: string;
  left_text: string;
  right_text: string;
  translation: string | null;
  dialect: string | null;
  author: string | null;
  uri: string | null;
}

/**
 * Structural search: match a sequence of token constraints via successive
 * self-joins on idx+1. The first NON-empty (non-wildcard) position anchors the
 * scan to keep it indexed; the chain of joins enforces adjacency.
 */
export async function structural(
  db: D1Database,
  opts: { pattern: string; limit: number; dialect?: string | null; region?: string | null; dialectPath?: string | null; author?: string | null },
): Promise<StructuralLine[]> {
  try {
    return await structuralImpl(db, opts, true);
  } catch (e) {
    if (!missingFoldColumn(e)) throw e;
    return await structuralImpl(db, opts, false);
  }
}

async function structuralImpl(
  db: D1Database,
  opts: Parameters<typeof structural>[1],
  useFold: boolean,
): Promise<StructuralLine[]> {
  const positions = parsePattern(opts.pattern);
  if (!positions.length) return [];
  if (positions.length > 6) positions.length = 6; // bound the join depth

  const keyCol = useFold ? "surface_fold" : "surface_norm";

  // Resolve regex slots to concrete key lists up front (one vocab scan per
  // distinct pattern, memoized on the db). An empty resolution can never match.
  const slotKeys: (string[] | null)[] = [];
  for (const p of positions) {
    if (!p.regex) { slotKeys.push(null); continue; }
    const keys = await regexNodeKeys(db, p.regex, keyCol);
    if (!keys.length) return [];
    slotKeys.push(keys);
  }

  const aliases = positions.map((_, i) => `t${i}`);
  const conds: string[] = [];
  const params: unknown[] = [];
  const posCond = (a: string, p: PatternPos, i: number): string[] => {
    const cs: string[] = [];
    if (p.surface) { cs.push(`${a}.${keyCol} = ?`); params.push(useFold ? p.surface : normToken(p.surface)); }
    if (p.prefix) { cs.push(`${a}.${keyCol} LIKE ? ESCAPE '\\'`); params.push(likeEscape(useFold ? p.prefix : normToken(p.prefix)) + "%"); }
    if (p.regex) { const keys = slotKeys[i]!; cs.push(`${a}.${keyCol} IN (${keys.map(() => "?").join(",")})`); params.push(...keys); }
    if (p.upos) { cs.push(`${a}.upos = ?`); params.push(p.upos.toUpperCase()); }
    if (p.lemma) { cs.push(`${a}.lemma = ?`); params.push(p.lemma); }
    return cs;
  };

  // FROM t0 JOIN t1 ON adjacency JOIN t2 … — but build constraints in order so
  // bound params line up with the alias order.
  let from = `corpus_tokens ${aliases[0]}`;
  conds.push(...posCond(aliases[0], positions[0], 0));
  for (let i = 1; i < positions.length; i++) {
    from += ` JOIN corpus_tokens ${aliases[i]} ON ${aliases[i]}.sentence_id = ${aliases[0]}.sentence_id AND ${aliases[i]}.idx = ${aliases[0]}.idx + ${i}`;
    conds.push(...posCond(aliases[i], positions[i], i));
  }
  from += ` JOIN sentences s ON s.id = ${aliases[0]}.sentence_id`;
  // structural() AND-joins `conds` itself, so add bare clauses (no " AND " prefix).
  const df = useFold ? (opts as DialectFilter) : { dialect: opts.dialect ?? null };
  const dw = dialectWhere("s", df);
  if (dw.sql) { conds.push(dw.sql.replace(/^ AND /, "")); params.push(...dw.params); }
  if (opts.author) { conds.push("instr(s.author, ?) > 0"); params.push(opts.author); }
  if (!conds.length) return []; // all-wildcard pattern: refuse a full scan

  const last = aliases[aliases.length - 1];
  // Select the matched tokens' fields directly off the joined aliases (t0…tn ARE
  // the matched tokens), so annotation needs NO per-row follow-up query. The old
  // code looped one query per result → 1 + limit subrequests, blowing the
  // Workers 50-subrequest cap. This is a single round-trip regardless of limit.
  const tokCols = aliases
    .map((a, i) => `${a}.idx AS i${i}, ${a}.surface AS s${i}, ${a}.surface_norm AS n${i}, ${a}.upos AS p${i}, ${a}.lemma AS l${i}`)
    .join(", ");
  const sql = `SELECT ${aliases[0]}.sentence_id AS sentence_id,
                      ${aliases[0]}.char_start AS a, ${last}.char_end AS b,
                      ${tokCols},
                      s.text, s.translation, s.dialect, s.author, s.uri
               FROM ${from}
               WHERE ${conds.join(" AND ")}
               ORDER BY ${aliases[0]}.sentence_id, ${aliases[0]}.idx
               LIMIT ?`;
  params.push(clampLimit(opts.limit) || 50);
  const { results } = await db.prepare(sql).bind(...params).all<Record<string, unknown>>();
  if (!results?.length) return [];

  return results.map((r) => {
    const match = positions.map((_, i) => ({
      i: r[`i${i}`] as number,
      s: r[`s${i}`] as string,
      n: r[`n${i}`] as string,
      p: (r[`p${i}`] as string | null) ?? null,
      l: (r[`l${i}`] as string | null) ?? null,
    }));
    const text = (r.text as string) ?? "";
    const a = r.a as number, b = r.b as number;
    return {
      sentence_id: r.sentence_id as string,
      match,
      match_text: text.slice(a, b),
      left_text: text.slice(Math.max(0, a - 40), a),
      right_text: text.slice(b, b + 40),
      translation: (r.translation as string | null) ?? null,
      dialect: (r.dialect as string | null) ?? null,
      author: (r.author as string | null) ?? null,
      uri: (r.uri as string | null) ?? null,
    };
  });
}

// ───────────────────────────── Analytics ───────────────────────────── //

/**
 * Basic analytics for a node word: total frequency, distribution across
 * dialects / authors / collections, and its UPOS spread (how the tagger
 * classifies it in context — useful for spotting polysemy/ambiguity).
 */
export async function wordAnalytics(
  db: D1Database,
  opts: { q: string; match: "fold" | "exact" | "prefix"; top: number;
          dialect?: string | null; region?: string | null; dialectPath?: string | null },
): Promise<{
  node: string;
  total: number;
  dialects: { key: string; count: number }[];
  authors: { key: string; count: number }[];
  collections: { key: string; count: number }[];
  upos: { key: string; count: number }[];
  regions: { key: string; count: number }[];
}> {
  try {
    return await wordAnalyticsImpl(db, opts, true);
  } catch (e) {
    if (!missingFoldColumn(e)) throw e;
    return await wordAnalyticsImpl(db, opts, false);
  }
}

async function wordAnalyticsImpl(
  db: D1Database,
  opts: Parameters<typeof wordAnalytics>[1],
  useFold: boolean,
): ReturnType<typeof wordAnalytics> {
  const top = Math.max(1, Math.min(Math.floor(opts.top) || 10, 100));
  const keyCol = useFold ? "surface_fold" : "surface_norm";
  let where: string;
  const p: unknown[] = [];
  if (opts.match === "prefix") { where = `t.${keyCol} LIKE ? ESCAPE '\\'`; p.push(likeEscape(useFold ? foldToken(opts.q) : normToken(opts.q)) + "%"); }
  else if (opts.match === "exact") { where = "t.surface_norm = ?"; p.push(normToken(opts.q)); }
  else { where = `t.${keyCol} = ?`; p.push(useFold ? foldToken(opts.q) : normToken(opts.q)); }

  // Optional dialect filter (so analytics can be scoped to a region/dialect too).
  const df = useFold ? (opts as DialectFilter) : { dialect: opts.dialect ?? null };
  const dw = dialectWhere("s", df);
  const needSentJoin = !!dw.sql;
  const baseWhere = where + dw.sql;
  const baseParams = [...p, ...dw.params];
  const baseFrom = needSentJoin
    ? "corpus_tokens t JOIN sentences s ON s.id = t.sentence_id"
    : "corpus_tokens t";

  const totalRow = await db.prepare(`SELECT count(*) c FROM ${baseFrom} WHERE ${baseWhere}`).bind(...baseParams).first<{ c: number }>();
  const total = totalRow?.c ?? 0;

  const breakdown = async (col: string, fromSent: boolean) => {
    const j = (fromSent || needSentJoin) ? "JOIN sentences s ON s.id = t.sentence_id" : "";
    const expr = fromSent ? `s.${col}` : `t.${col}`;
    const { results } = await db
      .prepare(
        `SELECT coalesce(${expr}, '—') AS key, count(*) AS count
         FROM corpus_tokens t ${j} WHERE ${baseWhere}
         GROUP BY key ORDER BY count DESC LIMIT ?`,
      )
      .bind(...baseParams, top)
      .all<{ key: string; count: number }>();
    return results ?? [];
  };

  const [dialects, authors, collections, upos, regions] = await Promise.all([
    breakdown("dialect", true),
    breakdown("author", true),
    breakdown("collection", true),
    breakdown("upos", false),
    useFold ? breakdown("dialect_path", true) : Promise.resolve([]),
  ]);
  return { node: opts.q, total, dialects, authors, collections, upos, regions };
}
