#!/usr/bin/env bun
/**
 * Build the text_documents reading index (migrations/0007_text_documents.sql)
 * from the sentences already loaded — locally into build/corpus.db, or on
 * Turso with --turso. load_tokens.mjs runs the same rebuild after a full
 * load; this script exists so an already-loaded store can gain the index
 * without reloading tokens.
 *
 *   bun scripts/build_text_documents.mjs
 *   TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… bun scripts/build_text_documents.mjs --turso
 */
import { readFileSync } from "node:fs";
import { TEXT_DOCUMENTS_REBUILD_SQL } from "../src/text.ts";

const TURSO = process.argv.includes("--turso");
const MIG7 = new URL("../migrations/0007_text_documents.sql", import.meta.url);

function* ddlStatements(sql) {
  const stripped = sql.replace(/--.*$/gm, "");
  for (const raw of stripped.split(";")) {
    const s = raw.trim();
    if (s) yield s;
  }
}

if (TURSO) {
  const { createClient } = await import("@libsql/client");
  const url = process.env.TURSO_DATABASE_URL, authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN");
  const db = createClient({ url, authToken });
  for (const s of ddlStatements(readFileSync(MIG7, "utf8"))) await db.execute(s);
  await db.batch(TEXT_DOCUMENTS_REBUILD_SQL.map((sql) => ({ sql, args: [] })), "write");
  const n = (await db.execute("SELECT count(*) c FROM text_documents")).rows[0].c;
  const s = (await db.execute("SELECT count(DISTINCT source_slug) c FROM text_documents")).rows[0].c;
  console.log(`turso: text_documents=${n} sources=${s}`);
} else {
  const { Database } = await import("bun:sqlite");
  const db = new Database(new URL("../build/corpus.db", import.meta.url).pathname);
  for (const s of ddlStatements(readFileSync(MIG7, "utf8"))) db.run(s);
  const tx = db.transaction(() => { for (const s of TEXT_DOCUMENTS_REBUILD_SQL) db.run(s); });
  tx();
  const n = db.query("SELECT count(*) c FROM text_documents").get().c;
  const s = db.query("SELECT count(DISTINCT source_slug) c FROM text_documents").get().c;
  console.log(`local build/corpus.db: text_documents=${n} sources=${s}`);
}
