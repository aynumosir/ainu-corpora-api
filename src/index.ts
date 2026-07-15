/**
 * ainu-corpora-api — standalone corpus API (corpus.aynu.org).
 *
 * Phase 0: behaviour-identical extraction of the corpus read endpoints that
 * used to live inside ainu-mcp's db.ts. Consumed by:
 *   - ainu-mcp via a CORPUS service binding (Worker-to-Worker, no public hop)
 *   - kampisos / frontends via public HTTPS (CORS-enabled)
 *
 * Contract: every response is an envelope
 *   { api_version: "1", data: <payload> }              on success
 *   { api_version: "1", error: { code, message } }     on failure
 * Routes are versioned under /v1. See README.md for the full contract.
 *
 * Normalization note: frequency/stopword endpoints take ALREADY-normalized
 * tokens (the same gaps-normalization the MCP applied before calling the old
 * helper). The MCP keeps doing that normalization in its thin proxy tool, so
 * the corpus API stays a faithful 1:1 of the lifted query helpers.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types.js";
import { LibsqlDb } from "./libsql.js";
import {
  corpusSearch,
  corpusLayerSearch,
  getMeta,
  tokenFrequency,
  frequencyList,
  stopwordsList,
  isStopword,
  vocabCandidates,
  type CorpusLang,
} from "./db.js";
import { concordance, posSearch, type SortMode, type MatchMode } from "./tokens.js";
import { kwic, kwicTotal, inflections, type NodeSort, type KwicMatch } from "./kwic.js";
import { collocations, structural, wordAnalytics } from "./analysis.js";
import { dialectTree } from "./dialect.js";
import { examplesFor } from "./examples.js";
import { BadRegexError } from "./regex.js";

type Vars = { db: D1Database };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use("*", cors());

// Build the libSQL shim once per request and stash it on the context.
app.use("*", async (c, next) => {
  // Test/local hook: a pre-built D1-shaped db may be injected via env (used by
  // the local bun:sqlite dev harness). Never set in production.
  const injected = (c.env as unknown as { __TEST_DB__?: D1Database }).__TEST_DB__;
  const db = injected ?? (new LibsqlDb(c.env.DATABASE_URL, c.env.DATABASE_AUTH_TOKEN) as unknown as D1Database);
  c.set("db", db);
  await next();
});

const ok = (c: any, data: unknown, meta?: unknown) =>
  c.json(meta === undefined
    ? { api_version: c.env.API_VERSION ?? "1", data }
    : { api_version: c.env.API_VERSION ?? "1", data, meta });
const fail = (c: any, status: number, code: string, message: string) =>
  c.json({ api_version: c.env.API_VERSION ?? "1", error: { code, message } }, status);

/** Parse an integer query param with a default and a floor. */
function intParam(v: string | undefined, dflt: number): number {
  if (v == null || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}
function boolParam(v: string | undefined, dflt: boolean): boolean {
  if (v == null || v === "") return dflt;
  return v === "1" || v.toLowerCase() === "true";
}

/**
 * Read the three-level dialect filter from query params, shared by every search
 * route. `region` = lv1 (北海道|樺太, the Hokkaido/Sakhalin tab); `dialect_path`
 * = a hierarchical prefix (北海道/南西 or 北海道/南西/沙流, the sub-select);
 * `dialect` = legacy free-text substring. All optional; all ANDed downstream.
 */
function dialectParams(c: any): { dialect: string | null; region: string | null; dialectPath: string | null } {
  return {
    dialect: c.req.query("dialect") ?? null,
    region: c.req.query("region") ?? null,
    dialectPath: c.req.query("dialect_path") ?? null,
  };
}

app.get("/health", (c) => ok(c, { ok: true, service: "ainu-corpora-api" }));

// ───────────────────────────── /v1/search ───────────────────────────── //
app.get("/v1/search", async (c) => {
  const q = c.req.query("q") ?? "";
  if (!q.trim()) return fail(c, 400, "missing_query", "q is required");
  const langRaw = c.req.query("lang") ?? "any";
  if (!["ain", "jpn", "any"].includes(langRaw)) return fail(c, 400, "bad_lang", "lang must be ain|jpn|any");
  const orthography = c.req.query("orthography") ?? "source";
  if (!["source", "modern"].includes(orthography)) {
    return fail(c, 400, "bad_orthography", "orthography must be source|modern");
  }
  const search = orthography === "modern" ? corpusLayerSearch : corpusSearch;
  const rows = await search(c.get("db"), {
    query: q,
    lang: langRaw as CorpusLang,
    dialect: c.req.query("dialect") ?? null,
    author: c.req.query("author") ?? null,
    limit: intParam(c.req.query("limit"), 20),
  });
  return ok(c, rows);
});

// ───────────────────────────── /v1/stats ───────────────────────────── //
app.get("/v1/stats", async (c) => {
  const raw = await getMeta(c.get("db"), "corpus_stats");
  return ok(c, raw ? JSON.parse(raw) : { sentences: 0, top_dialects: {} });
});

// Generic meta key/value read (raw string, or null). Used by the MCP frequency
// tool for precomputed totals (token_total_distinct / token_total_occurrences).
app.get("/v1/meta", async (c) => {
  const key = c.req.query("key") ?? "";
  if (!key) return fail(c, 400, "missing_key", "key is required");
  return ok(c, await getMeta(c.get("db"), key));
});

// ───────────────────────────── /v1/freq ───────────────────────────── //
// token is expected ALREADY normalized (MCP normalizes before calling).
app.get("/v1/freq/word", async (c) => {
  const token = c.req.query("token") ?? "";
  if (!token) return fail(c, 400, "missing_token", "token is required (already normalized)");
  const freq = await tokenFrequency(c.get("db"), token);
  const stop = freq ? freq.is_stopword : await isStopword(c.get("db"), token);
  return ok(c, { token, found: freq != null, ...(freq ?? {}), is_stopword: stop });
});

app.get("/v1/freq/list", async (c) => {
  const rows = await frequencyList(c.get("db"), {
    limit: intParam(c.req.query("limit"), 100),
    offset: intParam(c.req.query("offset"), 0),
    includeStopwords: boolParam(c.req.query("includeStopwords"), false),
    minCount: intParam(c.req.query("minCount"), 1),
  });
  return ok(c, rows);
});

// ───────────────────────────── /v1/stopwords ───────────────────────────── //
app.get("/v1/stopwords", async (c) => ok(c, await stopwordsList(c.get("db"))));
app.get("/v1/stopword", async (c) => {
  const token = c.req.query("token") ?? "";
  if (!token) return fail(c, 400, "missing_token", "token is required (already normalized)");
  return ok(c, { token, is_stopword: await isStopword(c.get("db"), token) });
});

// ───────────────────────────── /v1/candidates ───────────────────────────── //
// Raw corpus vocab-gap candidates. Live-glossary subtraction stays in the MCP.
app.get("/v1/candidates", async (c) =>
  ok(c, await vocabCandidates(c.get("db"), intParam(c.req.query("minCount"), 1))),
);

// ───────────────────────────── /v1/concordance (KWIC) ───────────────────────────── //
// Keyword-in-context over corpus_tokens. Node matches surface_norm (exact|prefix);
// left/node/right are sliced from the source sentence by char offset.
app.get("/v1/concordance", async (c) => {
  const q = c.req.query("q") ?? "";
  if (!q.trim()) return fail(c, 400, "missing_query", "q is required");
  const sortRaw = c.req.query("sort") ?? "none";
  const matchRaw = c.req.query("match") ?? "exact";
  const lines = await concordance(c.get("db"), {
    q,
    window: intParam(c.req.query("window"), 40),
    limit: intParam(c.req.query("limit"), 50),
    sort: (["none", "left", "right"].includes(sortRaw) ? sortRaw : "none") as SortMode,
    match: (matchRaw === "prefix" ? "prefix" : "exact") as MatchMode,
    dialect: c.req.query("dialect") ?? null,
    author: c.req.query("author") ?? null,
  });
  return ok(c, lines);
});

// ───────────────────────────── /v1/pos (POS-search) ───────────────────────────── //
// Match node tokens by upos/lemma/surface, optionally constrained by the next
// token (next_upos / next_surface) via a self-join. e.g. VERB + =an:
//   /v1/pos?upos=VERB&next_surface==an
app.get("/v1/pos", async (c) => {
  const lines = await posSearch(c.get("db"), {
    upos: c.req.query("upos") ?? null,
    lemma: c.req.query("lemma") ?? null,
    surface: c.req.query("surface") ?? null,
    nextUpos: c.req.query("next_upos") ?? null,
    nextSurface: c.req.query("next_surface") ?? null,
    window: intParam(c.req.query("window"), 40),
    limit: intParam(c.req.query("limit"), 50),
    dialect: c.req.query("dialect") ?? null,
    author: c.req.query("author") ?? null,
  });
  if (!lines.length && !c.req.query("upos") && !c.req.query("lemma") && !c.req.query("surface") && !c.req.query("next_upos") && !c.req.query("next_surface")) {
    return fail(c, 400, "missing_filter", "provide at least one of: upos, lemma, surface, next_upos, next_surface");
  }
  return ok(c, lines);
});

// ───────────────────────────── /v1/kwic (annotated KWIC) ───────────────────────────── //
// Token-level KWIC: each line carries left/node/right TOKEN arrays (surface +
// upos + lemma + xpos + feats + clitic flag) so the UI can show POS/gloss under
// every word, make words clickable, sort by the Nth neighbour, fold accents, and
// fold singular↔plural. `left_text`/`node_text`/`right_text` keep the plain grid.
app.get("/v1/kwic", async (c) => {
  const q = c.req.query("q") ?? "";
  if (!q.trim()) return fail(c, 400, "missing_query", "q is required");
  const sortRaw = c.req.query("sort") ?? "none";
  const SORTS = ["none", "left", "right", "l1", "l2", "l3", "r1", "r2", "r3", "node", "dialect", "author"];
  const matchRaw = c.req.query("match") ?? "fold";
  const expandRaw = c.req.query("expand") ?? "none";
  const cliticRaw = c.req.query("clitic") ?? "any";
  const limit = intParam(c.req.query("limit"), 50);
  const offset = Math.max(0, intParam(c.req.query("offset"), 0));
  const opts = {
    q,
    ctx: intParam(c.req.query("ctx"), 6),
    limit,
    offset,
    sort: (SORTS.includes(sortRaw) ? sortRaw : "none") as NodeSort,
    match: (["fold", "exact", "prefix", "regex"].includes(matchRaw) ? matchRaw : "fold") as KwicMatch,
    expand: (["none", "plural", "all"].includes(expandRaw) ? expandRaw : "none") as "none" | "plural" | "all",
    nodeUpos: c.req.query("upos") ?? null,
    clitic: (["any", "only", "exclude"].includes(cliticRaw) ? cliticRaw : "any") as "any" | "only" | "exclude",
    ...dialectParams(c),
    author: c.req.query("author") ?? null,
  };
  try {
    // total runs concurrently with the page fetch (one extra COUNT round-trip).
    const [lines, total] = await Promise.all([kwic(c.get("db"), opts), kwicTotal(c.get("db"), opts)]);
    return ok(c, lines, { total, offset, limit });
  } catch (e) {
    if (e instanceof BadRegexError) return fail(c, 400, "bad_regex", e.message);
    throw e;
  }
});

// ───────────────────────────── /v1/collocation ───────────────────────────── //
// Tokens co-occurring within ±window positions of a node, scored by
// logDice / t-score / MI. e.g. ?q=kamuy&window=5&measure=log_dice
app.get("/v1/collocation", async (c) => {
  const q = c.req.query("q") ?? "";
  if (!q.trim()) return fail(c, 400, "missing_query", "q is required");
  const spanRaw = c.req.query("span") ?? "both";
  const measRaw = c.req.query("measure") ?? "log_dice";
  const data = await collocations(c.get("db"), {
    q,
    window: intParam(c.req.query("window"), 5),
    span: (["both", "left", "right"].includes(spanRaw) ? spanRaw : "both") as "both" | "left" | "right",
    minCount: intParam(c.req.query("minCount"), 3),
    limit: intParam(c.req.query("limit"), 50),
    measure: (["log_dice", "t_score", "mi"].includes(measRaw) ? measRaw : "log_dice") as "log_dice" | "t_score" | "mi",
    ...dialectParams(c),
    author: c.req.query("author") ?? null,
  });
  return ok(c, data);
});

// ───────────────────────────── /v1/structural (CQL-lite) ───────────────────────────── //
// Adjacent token-sequence search. e.g. ?pattern=[upos=NOUN] [upos=NOUN]
// Positions can be word regexes: ?pattern=/ech?i/ /^a/
app.get("/v1/structural", async (c) => {
  const pattern = c.req.query("pattern") ?? c.req.query("q") ?? "";
  if (!pattern.trim()) return fail(c, 400, "missing_pattern", "pattern is required (e.g. [upos=VERB] [surface==an])");
  try {
    const lines = await structural(c.get("db"), {
      pattern,
      limit: intParam(c.req.query("limit"), 50),
      ...dialectParams(c),
      author: c.req.query("author") ?? null,
    });
    return ok(c, lines);
  } catch (e) {
    if (e instanceof BadRegexError) return fail(c, 400, "bad_regex", e.message);
    throw e;
  }
});

// ───────────────────────────── /v1/analytics ───────────────────────────── //
// Distribution of a node word across dialect/author/collection + its POS spread.
app.get("/v1/analytics", async (c) => {
  const q = c.req.query("q") ?? "";
  if (!q.trim()) return fail(c, 400, "missing_query", "q is required");
  const matchRaw = c.req.query("match") ?? "fold";
  const data = await wordAnalytics(c.get("db"), {
    q,
    match: (["fold", "exact", "prefix"].includes(matchRaw) ? matchRaw : "fold") as "fold" | "exact" | "prefix",
    top: intParam(c.req.query("top"), 10),
    ...dialectParams(c),
  });
  return ok(c, data);
});

// ───────────────────────────── /v1/inflections ───────────────────────────── //
// Inflectional relatives of a word (singular↔plural, possessed forms) from the
// morpheme-database morphology layer. Powers the UI inflection chooser.
app.get("/v1/inflections", async (c) => {
  const word = c.req.query("word") ?? c.req.query("q") ?? "";
  if (!word.trim()) return fail(c, 400, "missing_word", "word is required");
  return ok(c, await inflections(c.get("db"), word));
});

// ───────────────────────────── /v1/dialects ───────────────────────────── //
// The three-level dialect taxonomy present in the corpus, as a tree:
//   region (北海道|樺太) → area (南西/北東/西海岸/東海岸) → specific dialect.
// Powers the UI Hokkaido/Sakhalin tab + dialect sub-select.
app.get("/v1/dialects", async (c) => {
  try {
    return ok(c, await dialectTree(c.get("db")));
  } catch (e) {
    // Pre-Phase-5 schema (no dialect_path column) → empty tree, not a 500.
    if (/no such column/i.test(String(e))) return ok(c, []);
    throw e;
  }
});

// ───────────────────────────── /v1/examples ───────────────────────────── //
// Curated, runnable search examples (a self-describing tour of every surface).
// Optionally filter by ?mode=kwic|pos|collocation|structural|analytics|inflection|text
app.get("/v1/examples", (c) => ok(c, examplesFor(c.req.query("mode"))));

app.notFound((c) => fail(c, 404, "not_found", `no route for ${c.req.path}`));
app.onError((err, c) => {
  console.error("corpus-api error", err);
  return fail(c, 500, "internal", err instanceof Error ? err.message : "internal error");
});

export default app;
