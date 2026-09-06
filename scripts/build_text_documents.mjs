#!/usr/bin/env bun
/**
 * Build the text_documents reading index (migrations/0007_text_documents.sql)
 * from the sentences already loaded — locally into build/corpus.db, or on
 * Turso with --turso. load_tokens.mjs runs the same rebuild after a full
 * load; this script exists so an already-loaded store can gain the index
 * without reloading tokens. Collections named in data/text_exclusions.json
 * are left out, and a store whose documents are not contiguous in
 * row_order is refused.
 *
 *   bun scripts/build_text_documents.mjs
 *   TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… bun scripts/build_text_documents.mjs --turso
 */
import { readFileSync } from "node:fs";
import { TEXT_CONTIGUITY_SQL, textDocumentsRebuild } from "../src/text.ts";

const TURSO = process.argv.includes("--turso");
const MIG7 = new URL("../migrations/0007_text_documents.sql", import.meta.url);
const EXCLUSIONS = new URL("../data/text_exclusions.json", import.meta.url);

function* ddlStatements(sql) {
  const stripped = sql.replace(/--.*$/gm, "");
  for (const raw of stripped.split(";")) {
    const s = raw.trim();
    if (s) yield s;
  }
}
const excluded = Object.keys(JSON.parse(readFileSync(EXCLUSIONS, "utf8")));
const rebuild = textDocumentsRebuild(excluded);

function refuse(violations) {
  throw new Error(`${violations} documents are not contiguous in row_order; text_documents left as it was`);
}

if (TURSO) {
  const { createClient } = await import("@libsql/client");
  const url = process.env.TURSO_DATABASE_URL, authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN");
  const db = createClient({ url, authToken });
  for (const s of ddlStatements(readFileSync(MIG7, "utf8"))) await db.execute(s);
  const violations = Number((await db.execute(TEXT_CONTIGUITY_SQL)).rows[0].violations);
  if (violations > 0) refuse(violations);
  await db.batch(rebuild.map((sql) => ({ sql, args: [] })), "write");
  const n = (await db.execute("SELECT count(*) c FROM text_documents")).rows[0].c;
  const s = (await db.execute("SELECT count(DISTINCT source_slug) c FROM text_documents")).rows[0].c;
  console.log(`turso: text_documents=${n} sources=${s} (excluded ${excluded.length} collections)`);
} else {
  const { Database } = await import("bun:sqlite");
  const db = new Database(new URL("../build/corpus.db", import.meta.url).pathname);
  for (const s of ddlStatements(readFileSync(MIG7, "utf8"))) db.run(s);
  const violations = Number(db.query(TEXT_CONTIGUITY_SQL).get().violations);
  if (violations > 0) refuse(violations);
  db.transaction(() => { for (const s of rebuild) db.run(s); })();
  const n = db.query("SELECT count(*) c FROM text_documents").get().c;
  const s = db.query("SELECT count(DISTINCT source_slug) c FROM text_documents").get().c;
  console.log(`local build/corpus.db: text_documents=${n} sources=${s} (excluded ${excluded.length} collections)`);
}
