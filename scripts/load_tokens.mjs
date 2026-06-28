#!/usr/bin/env bun
/**
 * Phase 1 loader: build/{sentences,tokens}.jsonl -> SQLite (local dry-run) or
 * the Turso corpus DB (--turso).
 *
 *   bun scripts/load_tokens.mjs                 # local dry-run -> build/corpus.db + validation
 *   TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… \
 *     bun scripts/load_tokens.mjs --turso       # apply migration + load into Turso
 *
 * Local mode validates counts and runs a sample KWIC + an adjacency self-join so
 * we eyeball correctness before touching prod. Turso mode batches multi-row
 * INSERTs (the per-statement `turso db shell < file` stream dies on big files).
 */
import { readFileSync } from "node:fs";

const TURSO = process.argv.includes("--turso");
const MIG = new URL("../migrations/0001_tokens.sql", import.meta.url);
const SENT = new URL("../build/sentences.jsonl", import.meta.url);
const TOK = new URL("../build/tokens.jsonl", import.meta.url);

function* ddlStatements(sql) {
  for (const raw of sql.split(";")) {
    const s = raw.replace(/--.*$/gm, "").trim();
    if (s) yield s;
  }
}
function readJsonl(url) {
  return readFileSync(url, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const SENT_COLS = ["id", "row_order", "text", "translation", "dialect", "author", "collection", "document", "uri"];
const TOK_COLS = ["sentence_id", "idx", "surface", "surface_norm", "char_start", "char_end", "script", "is_clitic"];
const sentRow = (r) => [r.id, r.o, r.text, r.tr ?? null, r.dia ?? null, r.au ?? null, r.col ?? null, r.doc ?? null, r.uri ?? null];
const tokRow = (r) => [r.s, r.i, r.surf, r.norm, r.a, r.b, r.sc, r.cl];

async function loadTurso() {
  const { createClient } = await import("@libsql/client");
  const url = process.env.TURSO_DATABASE_URL, authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN");
  const db = createClient({ url, authToken });

  console.log("applying migration…");
  for (const s of ddlStatements(readFileSync(MIG, "utf8"))) await db.execute(s);

  const insertBatched = async (table, cols, rows, perStmt, perBatch) => {
    const ph = "(" + cols.map(() => "?").join(",") + ")";
    let done = 0;
    for (const batch of chunk(chunk(rows, perStmt), perBatch)) {
      const stmts = batch.map((group) => ({
        sql: `INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES ${group.map(() => ph).join(",")}`,
        args: group.flat(),
      }));
      await db.batch(stmts, "write");
      done += batch.reduce((a, g) => a + g.length, 0);
      process.stdout.write(`\r  ${table}: ${done}/${rows.length}`);
    }
    process.stdout.write("\n");
  };

  console.log("loading sentences…");
  await insertBatched("sentences", SENT_COLS, readJsonl(SENT).map(sentRow), 200, 20);
  console.log("loading tokens…");
  await insertBatched("corpus_tokens", TOK_COLS, readJsonl(TOK).map(tokRow), 200, 30);

  const c1 = (await db.execute("SELECT count(*) c FROM sentences")).rows[0].c;
  const c2 = (await db.execute("SELECT count(*) c FROM corpus_tokens")).rows[0].c;
  console.log(`done: sentences=${c1} corpus_tokens=${c2}`);
}

async function loadLocal() {
  const { Database } = await import("bun:sqlite");
  const db = new Database(new URL("../build/corpus.db", import.meta.url).pathname, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  for (const s of ddlStatements(readFileSync(MIG, "utf8"))) db.run(s);
  db.run("DELETE FROM corpus_tokens"); db.run("DELETE FROM sentences");

  const insert = (table, cols, rows) => {
    const ph = "(" + cols.map(() => "?").join(",") + ")";
    const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES ${ph}`);
    const tx = db.transaction((batch) => { for (const r of batch) stmt.run(...r); });
    tx(rows);
  };
  insert("sentences", SENT_COLS, readJsonl(SENT).map(sentRow));
  insert("corpus_tokens", TOK_COLS, readJsonl(TOK).map(tokRow));

  const nS = db.query("SELECT count(*) c FROM sentences").get().c;
  const nT = db.query("SELECT count(*) c FROM corpus_tokens").get().c;
  console.log(`\nlocal build/corpus.db: sentences=${nS} corpus_tokens=${nT}`);

  console.log("\n— sample KWIC for node 'rayke' (left | NODE | right) —");
  const kwic = db.query(
    `SELECT t.sentence_id, s.text, t.char_start a, t.char_end b
     FROM corpus_tokens t JOIN sentences s ON s.id = t.sentence_id
     WHERE t.surface_norm = ? ORDER BY t.sentence_id LIMIT 4`,
  ).all("rayke");
  for (const r of kwic) {
    const L = r.text.slice(Math.max(0, r.a - 24), r.a);
    const N = r.text.slice(r.a, r.b);
    const R = r.text.slice(r.b, r.b + 24);
    console.log(`  …${L}[${N}]${R}…`);
  }

  console.log("\n— adjacency: tokens immediately followed by '=an' (top surfaces) —");
  const adj = db.query(
    `SELECT a.surface_norm w, count(*) c
     FROM corpus_tokens a JOIN corpus_tokens b
       ON b.sentence_id = a.sentence_id AND b.idx = a.idx + 1
     WHERE b.surface_norm = '=an' AND a.surface_norm <> ''
     GROUP BY a.surface_norm ORDER BY c DESC LIMIT 8`,
  ).all();
  for (const r of adj) console.log(`  ${r.w}  ×${r.c}`);
}

await (TURSO ? loadTurso() : loadLocal());
