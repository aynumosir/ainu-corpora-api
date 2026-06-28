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
  getMeta,
  tokenFrequency,
  frequencyList,
  stopwordsList,
  isStopword,
  vocabCandidates,
  type CorpusLang,
} from "./db.js";

type Vars = { db: D1Database };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use("*", cors());

// Build the libSQL shim once per request and stash it on the context.
app.use("*", async (c, next) => {
  const db = new LibsqlDb(c.env.DATABASE_URL, c.env.DATABASE_AUTH_TOKEN) as unknown as D1Database;
  c.set("db", db);
  await next();
});

const ok = (c: any, data: unknown) => c.json({ api_version: c.env.API_VERSION ?? "1", data });
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

app.get("/health", (c) => ok(c, { ok: true, service: "ainu-corpora-api" }));

// ───────────────────────────── /v1/search ───────────────────────────── //
app.get("/v1/search", async (c) => {
  const q = c.req.query("q") ?? "";
  if (!q.trim()) return fail(c, 400, "missing_query", "q is required");
  const langRaw = c.req.query("lang") ?? "any";
  if (!["ain", "jpn", "any"].includes(langRaw)) return fail(c, 400, "bad_lang", "lang must be ain|jpn|any");
  const rows = await corpusSearch(c.get("db"), {
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

app.notFound((c) => fail(c, 404, "not_found", `no route for ${c.req.path}`));
app.onError((err, c) => {
  console.error("corpus-api error", err);
  return fail(c, 500, "internal", err instanceof Error ? err.message : "internal error");
});

export default app;
