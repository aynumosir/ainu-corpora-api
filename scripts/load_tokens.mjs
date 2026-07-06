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
import { foldToken } from "../src/normalize.ts";

const TURSO = process.argv.includes("--turso");
const tokArg = process.argv.find((a) => a.startsWith("--tokens="));
const TOK_FILE = tokArg ? tokArg.slice("--tokens=".length) : "../build/tokens.jsonl";
const MIG = new URL("../migrations/0001_tokens.sql", import.meta.url);
const MIG2 = new URL("../migrations/0002_fold_and_morph.sql", import.meta.url);
const MIG3 = new URL("../migrations/0003_dialect_levels.sql", import.meta.url);
const MIG4 = new URL("../migrations/0004_morph_gloss.sql", import.meta.url);
const MIG5 = new URL("../migrations/0005_source_slug.sql", import.meta.url);
const SENT = new URL("../build/sentences.jsonl", import.meta.url);
const SLUGS = new URL("../data/collection_slugs.json", import.meta.url);
const TOK = new URL(TOK_FILE, import.meta.url);
const MORPH = new URL("../build/morph_forms.jsonl", import.meta.url);
const GLOSS = new URL("../build/morph_gloss.jsonl", import.meta.url);

function* ddlStatements(sql) {
  // Strip line comments FIRST so a stray ';' inside a comment can't split a statement.
  const stripped = sql.replace(/--.*$/gm, "");
  for (const raw of stripped.split(";")) {
    const s = raw.trim();
    if (s) yield s;
  }
}
function readJsonl(url) {
  return readFileSync(url, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function readJsonlIfExists(url) {
  try {
    return readJsonl(url);
  } catch {
    return null;
  }
}
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const SENT_COLS = ["id", "row_order", "text", "translation", "dialect", "author", "collection", "document", "uri",
  "region", "dialect_path", "dialect_paths", "source_slug"];
const TOK_COLS = ["sentence_id", "idx", "surface", "surface_norm", "char_start", "char_end", "script", "is_clitic",
  "lemma", "upos", "xpos", "feats_json", "model_version", "surface_fold"];
// U+001F (unit separator) wraps each stored dialect path so a hierarchical
// membership test is a single anchored substring scan (see 0003 migration).
const US = "\u001f";
/** Derive {region, dialect_path, dialect_paths} from the lv1/2/3 arrays. */
function dialectLevels(r) {
  const d1 = Array.isArray(r.d1) ? r.d1 : [];
  const d2 = Array.isArray(r.d2) ? r.d2 : [];
  const d3 = Array.isArray(r.d3) ? r.d3 : [];
  const region = d1.length ? String(d1[0]).split("/")[0] : null;
  // Most-specific paths: prefer lv3, else lv2, else lv1.
  const specific = d3.length ? d3 : d2.length ? d2 : d1;
  const paths = [...new Set(specific.map(String).filter(Boolean))];
  const dialect_path = paths.length ? paths[0] : null;
  const dialect_paths = paths.length ? US + paths.join(US) + US : null;
  return { region, dialect_path, dialect_paths };
}
// db.aynu.org source record per collection (see migrations/0005_source_slug.sql).
// Keyed by the corpus collection title (= collection_lv1). Standalone texts
// (single documents registered without a collection, e.g. prague/kayano-kokkai)
// carry their title in `doc` instead, so fall back to it only when `col` is null.
const collectionSlugs = JSON.parse(readFileSync(SLUGS, "utf8"));
const sourceSlug = (r) =>
  (r.col != null ? collectionSlugs[r.col] : collectionSlugs[r.doc]) ?? null;
const sentRow = (r) => {
  const d = dialectLevels(r);
  return [r.id, r.o, r.text, r.tr ?? null, r.dia ?? null, r.au ?? null, r.col ?? null, r.doc ?? null, r.uri ?? null,
    d.region, d.dialect_path, d.dialect_paths, sourceSlug(r)];
};
// POS keys (lem/up/xp/ft/mv) are present in the Phase-3 tokens_pos.jsonl, null otherwise.
// surface_fold is computed here at load time (NFD diacritic folding can't be done in SQL).
const tokRow = (r) => [r.s, r.i, r.surf, r.norm, r.a, r.b, r.sc, r.cl,
  r.lem ?? null, r.up ?? null, r.xp ?? null, r.ft ?? null, r.mv ?? null, foldToken(r.norm ?? r.surf ?? "")];

const MORPH_COLS = ["lemma", "lemma_fold", "surface", "surface_fold", "relation", "number_locus",
  "form_length", "source", "confidence", "rule_id"];
const morphRow = (r) => [r.lemma, r.lemma_fold, r.surface, r.surface_fold, r.relation,
  r.number_locus ?? null, r.form_length ?? null, r.source ?? null, r.confidence ?? null, r.rule_id ?? null];

const GLOSS_COLS = ["key_fold", "key", "lemma", "category", "morph_type", "pos_display", "gloss_en", "gloss_jp", "source_id", "priority", "alternates"];
const glossRow = (r) => [r.key_fold, r.key, r.lemma ?? null, r.category ?? null, r.morph_type ?? null,
  r.pos_display ?? null, r.gloss_en ?? null, r.gloss_jp ?? null, r.source_id ?? null, r.priority ?? 0, r.alternates ?? null];

const BULK_INDEXES = [
  "idx_tokens_surface_norm",
  "idx_tokens_lemma",
  "idx_tokens_upos",
  "idx_tokens_norm_sent_idx",
  "idx_tokens_upos_sent_idx",
  "idx_tokens_surface_fold",
  "idx_tokens_fold_sent_idx",
  "idx_morph_lemma_fold",
  "idx_morph_surface_fold",
  "idx_morph_relation",
  "idx_morph_gloss_key_fold",
  "idx_morph_gloss_category",
];

async function dropBulkIndexes(db) {
  for (const idx of BULK_INDEXES) await db.execute(`DROP INDEX IF EXISTS ${idx}`);
}

async function createBulkIndexes(db) {
  const stmts = [
    "CREATE INDEX IF NOT EXISTS idx_tokens_surface_norm ON corpus_tokens (surface_norm)",
    "CREATE INDEX IF NOT EXISTS idx_tokens_lemma ON corpus_tokens (lemma)",
    "CREATE INDEX IF NOT EXISTS idx_tokens_upos ON corpus_tokens (upos)",
    "CREATE INDEX IF NOT EXISTS idx_tokens_norm_sent_idx ON corpus_tokens (surface_norm, sentence_id, idx)",
    "CREATE INDEX IF NOT EXISTS idx_tokens_upos_sent_idx ON corpus_tokens (upos, sentence_id, idx)",
    "CREATE INDEX IF NOT EXISTS idx_tokens_surface_fold ON corpus_tokens (surface_fold)",
    "CREATE INDEX IF NOT EXISTS idx_tokens_fold_sent_idx ON corpus_tokens (surface_fold, sentence_id, idx)",
    "CREATE INDEX IF NOT EXISTS idx_morph_lemma_fold ON morph_forms (lemma_fold)",
    "CREATE INDEX IF NOT EXISTS idx_morph_surface_fold ON morph_forms (surface_fold)",
    "CREATE INDEX IF NOT EXISTS idx_morph_relation ON morph_forms (relation)",
    "CREATE INDEX IF NOT EXISTS idx_morph_gloss_key_fold ON morph_gloss (key_fold)",
    "CREATE INDEX IF NOT EXISTS idx_morph_gloss_category ON morph_gloss (category)",
  ];
  for (const s of stmts) await db.execute(s);
}

async function loadTurso() {
  const { createClient } = await import("@libsql/client");
  const url = process.env.TURSO_DATABASE_URL, authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN");
  const db = createClient({ url, authToken });

  console.log("applying migration…");
  for (const s of ddlStatements(readFileSync(MIG, "utf8"))) await db.execute(s);
  for (const s of ddlStatements(readFileSync(MIG2, "utf8"))) {
    try { await db.execute(s); } catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
  }
  for (const s of ddlStatements(readFileSync(MIG3, "utf8"))) {
    try { await db.execute(s); } catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
  }
  for (const s of ddlStatements(readFileSync(MIG4, "utf8"))) {
    try { await db.execute(s); } catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
  }
  for (const s of ddlStatements(readFileSync(MIG5, "utf8"))) {
    try { await db.execute(s); } catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
  }

  console.log("dropping bulk-load indexes…");
  await dropBulkIndexes(db);

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
  await db.execute("DELETE FROM corpus_tokens");
  await insertBatched("corpus_tokens", TOK_COLS, readJsonl(TOK).map(tokRow), 200, 30);
  const morph = readJsonlIfExists(MORPH);
  if (morph) {
    console.log("loading morph_forms…");
    await db.execute("DELETE FROM morph_forms");
    await insertBatched("morph_forms", MORPH_COLS, morph.map(morphRow), 200, 20);
  } else {
    console.log("(no build/morph_forms.jsonl — run scripts/build_morph.mjs first; skipping)");
  }
  const gloss = readJsonlIfExists(GLOSS);
  if (gloss) {
    console.log("loading morph_gloss…");
    await db.execute("DELETE FROM morph_gloss");
    await insertBatched("morph_gloss", GLOSS_COLS, gloss.map(glossRow), 200, 20);
  } else {
    console.log("(no build/morph_gloss.jsonl — run scripts/build_gloss.mjs first; skipping)");
  }

  console.log("recreating indexes…");
  await createBulkIndexes(db);

  const c1 = (await db.execute("SELECT count(*) c FROM sentences")).rows[0].c;
  const c2 = (await db.execute("SELECT count(*) c FROM corpus_tokens")).rows[0].c;
  console.log(`done: sentences=${c1} corpus_tokens=${c2}`);
}

async function loadLocal() {
  const { Database } = await import("bun:sqlite");
  const db = new Database(new URL("../build/corpus.db", import.meta.url).pathname, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  for (const s of ddlStatements(readFileSync(MIG, "utf8"))) db.run(s);
  for (const s of ddlStatements(readFileSync(MIG2, "utf8"))) {
    try { db.run(s); } catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
  }
  for (const s of ddlStatements(readFileSync(MIG3, "utf8"))) {
    try { db.run(s); } catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
  }
  for (const s of ddlStatements(readFileSync(MIG4, "utf8"))) {
    try { db.run(s); } catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
  }
  for (const s of ddlStatements(readFileSync(MIG5, "utf8"))) {
    try { db.run(s); } catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
  }
  db.run("DELETE FROM corpus_tokens"); db.run("DELETE FROM sentences");

  const insert = (table, cols, rows) => {
    const ph = "(" + cols.map(() => "?").join(",") + ")";
    const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES ${ph}`);
    const tx = db.transaction((batch) => { for (const r of batch) stmt.run(...r); });
    tx(rows);
  };
  insert("sentences", SENT_COLS, readJsonl(SENT).map(sentRow));
  insert("corpus_tokens", TOK_COLS, readJsonl(TOK).map(tokRow));
  const morph = readJsonlIfExists(MORPH);
  if (morph) {
    db.run("DELETE FROM morph_forms");
    insert("morph_forms", MORPH_COLS, morph.map(morphRow));
    console.log(`morph_forms: ${morph.length} rows loaded`);
  } else {
    console.log("(no build/morph_forms.jsonl — run scripts/build_morph.mjs first; skipping)");
  }
  const gloss = readJsonlIfExists(GLOSS);
  if (gloss) {
    db.run("DELETE FROM morph_gloss");
    insert("morph_gloss", GLOSS_COLS, gloss.map(glossRow));
    console.log(`morph_gloss: ${gloss.length} rows loaded`);
  } else {
    console.log("(no build/morph_gloss.jsonl — run scripts/build_gloss.mjs first; skipping)");
  }

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
