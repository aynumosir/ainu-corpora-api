#!/usr/bin/env bun
/**
 * Load build/{gloss_layers,curated_gloss}.jsonl (see build_curated_gloss.py)
 * into the local corpus DB or Turso.
 *
 *   bun scripts/load_curated_gloss.mjs             # local -> build/corpus.db + validation
 *   TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… \
 *     bun scripts/load_curated_gloss.mjs --turso   # apply migration + load into Turso
 *
 * Idempotent per layer: existing rows for the layer ids being loaded are
 * deleted first, so a re-run after regenerating a layer replaces it cleanly.
 * Local mode cross-checks every sentence_id against `sentences` so an
 * anchoring drift (renamed document, shifted index) fails HERE, not in prod.
 */
import { readFileSync } from "node:fs";

const TURSO = process.argv.includes("--turso");
const MIG = new URL("../migrations/0006_curated_gloss.sql", import.meta.url);
const LAYERS = new URL("../build/gloss_layers.jsonl", import.meta.url);
const ROWS = new URL("../build/curated_gloss.jsonl", import.meta.url);

function* ddlStatements(sql) {
  const stripped = sql.replace(/--.*$/gm, "");
  for (const raw of stripped.split(";")) {
    const s = raw.trim();
    if (s) yield s;
  }
}
const readJsonl = (url) =>
  readFileSync(url, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

const LAYER_COLS = ["id", "credibility", "language", "status", "author", "origin_url", "origin_title",
  "description", "source_repository", "source_revision", "retrieved_at"];
const ROW_COLS = ["layer_id", "sentence_id", "part_idx", "ain", "gloss", "interp", "aligned",
  "pairs", "notes", "divergence"];
const pick = (cols) => (r) => cols.map((c) => r[c] ?? null);

const layers = readJsonl(LAYERS);
const rows = readJsonl(ROWS);
const layerIds = layers.map((l) => l.id);
console.log(`loading ${layers.length} layer(s), ${rows.length} part rows`);

async function load(db) {
  for (const s of ddlStatements(readFileSync(MIG, "utf8"))) await db.execute(s);
  for (const id of layerIds) {
    await db.execute({ sql: "DELETE FROM curated_gloss WHERE layer_id = ?", args: [id] });
    await db.execute({ sql: "DELETE FROM gloss_layers WHERE id = ?", args: [id] });
  }
  const insert = async (table, cols, data) => {
    for (const batch of chunk(data.map(pick(cols)), 50)) {
      const placeholders = batch.map(() => `(${cols.map(() => "?").join(",")})`).join(",");
      await db.execute({
        sql: `INSERT INTO ${table} (${cols.join(",")}) VALUES ${placeholders}`,
        args: batch.flat(),
      });
    }
  };
  await insert("gloss_layers", LAYER_COLS, layers);
  await insert("curated_gloss", ROW_COLS, rows);
}

if (TURSO) {
  const { createClient } = await import("@libsql/client");
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    console.error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN required with --turso");
    process.exit(1);
  }
  const client = createClient({ url, authToken });
  await load(client);
  const n = await client.execute("SELECT COUNT(*) AS c FROM curated_gloss");
  console.log(`turso: curated_gloss now holds ${n.rows[0].c} rows`);
} else {
  const { Database } = await import("bun:sqlite");
  const sq = new Database(new URL("../build/corpus.db", import.meta.url).pathname);
  const db = { execute: (q) => (typeof q === "string" ? sq.run(q) : sq.run(q.sql, q.args)) };
  await load(db);
  // Validation: every sentence_id must exist in `sentences`.
  const missing = sq
    .query(
      `SELECT g.sentence_id FROM curated_gloss g
       LEFT JOIN sentences s ON s.id = g.sentence_id WHERE s.id IS NULL`,
    )
    .all();
  const total = sq.query("SELECT COUNT(*) AS c FROM curated_gloss").get().c;
  const covered = sq.query("SELECT COUNT(DISTINCT sentence_id) AS c FROM curated_gloss").get().c;
  console.log(`local: ${total} part rows over ${covered} sentences`);
  if (missing.length) {
    console.error(`ANCHORING FAILURE — ${missing.length} sentence ids not in corpus:`);
    for (const m of missing.slice(0, 10)) console.error("  " + m.sentence_id);
    process.exit(1);
  }
  console.log("all sentence ids anchor to corpus sentences ✓");
}
