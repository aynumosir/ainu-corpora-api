/**
 * Continuous-text read helpers (src/text.ts) against an in-memory SQLite DB
 * shaped by the sentences migrations plus 0007_text_documents.sql: the
 * rebuild SQL, document order, paging inside a document, neighbour
 * navigation, and the missing-schema grace path.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  TEXT_DOCUMENTS_REBUILD_SQL,
  TEXT_PAGE_LIMIT_DEFAULT,
  TEXT_PAGE_LIMIT_MAX,
  textDocument,
  textDocuments,
  textSources,
} from "../src/text.ts";

function d1Of(sq: Database): D1Database {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) {
          args = a;
          return stmt;
        },
        async all<T>() {
          return { results: sq.query(sql).all(...(args as never[])) as T[] };
        },
        async first<T>() {
          return (sq.query(sql).get(...(args as never[])) as T) ?? null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

function migrate(sq: Database, ...files: string[]) {
  for (const f of files) {
    const sql = readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8").replace(/--.*$/gm, "");
    for (const raw of sql.split(";")) {
      const s = raw.trim();
      if (s) sq.run(s);
    }
  }
}

type Row = [string, number, string, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null];

function seeded(): { db: D1Database; sq: Database } {
  const sq = new Database(":memory:");
  migrate(sq, "0001_tokens.sql", "0005_source_slug.sql", "0006_text_layers.sql", "0007_text_documents.sql");
  const ins = sq.prepare(
    `INSERT INTO sentences (id, row_order, text, translation, dialect, author, collection, document, uri, source_slug, legacy_text, text_layer, text_layer_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const rows: unknown[][] = [
    // asai: two documents, layered (modern sidecar), the second one untranslated in part
    ["aa-asai/001#0", 10, "haciko monimahpo", "さらわれた娘", "小田洲", "浅井 タケ", "浅井タケ昔話全集 I, II", "さらわれた娘", "http://x/at01", "asai-take-folktales", "hachiko monimahpo", "modern-orthography-latn@1", "provisional"],
    ["aa-asai/001#1", 11, "maas pontara", "マース", "小田洲", "浅井 タケ", "浅井タケ昔話全集 I, II", "さらわれた娘", "http://x/at01", "asai-take-folktales", "maas pontara", "modern-orthography-latn@1", "provisional"],
    ["aa-asai/001#2", 12, "sine kotan", "ある村", "小田洲", "浅井 タケ", "浅井タケ昔話全集 I, II", "さらわれた娘", "http://x/at01", "asai-take-folktales", "shine kotan", "modern-orthography-latn@1", "provisional"],
    ["aa-asai/002#0", 13, "kamuy", "神", "小田洲", "浅井 タケ", "浅井タケ昔話全集 I, II", "神の話", "http://x/at02", "asai-take-folktales", "kamui", "modern-orthography-latn@1", "provisional"],
    ["aa-asai/002#1", 14, "ek", "", "小田洲", "浅井 タケ", "浅井タケ昔話全集 I, II", "神の話", "http://x/at02", "asai-take-folktales", "ek", "modern-orthography-latn@1", "provisional"],
    // biratori: unlayered, one document
    ["biratori/007#0", 20, "Iskar emko ta", "石狩の", "沙流", null, "平取町アイヌ口承文芸", "ユㇰ シキ", "http://x/b7", "biratori-ainu-oral-literature", null, null, null],
    // unregistered collection: never a document
    ["twitter/001#0", 30, "cupupet", null, null, null, "X", "X", null, null, null, null, null],
    ["twitter/001#1", 31, "cupupet", null, null, null, "X", "X", null, "", null, null, null],
  ];
  const tx = sq.transaction(() => { for (const r of rows) ins.run(...(r as never[])); });
  tx();
  for (const s of TEXT_DOCUMENTS_REBUILD_SQL) sq.run(s);
  return { db: d1Of(sq), sq };
}

test("rebuild: one row per registered document with its contiguous row range", () => {
  const { sq } = seeded();
  const docs = sq.query("SELECT source_slug, key, ord, title, row_start, row_end, sentences, translated, text_layer, text_layer_status FROM text_documents ORDER BY source_slug, ord").all() as any[];
  expect(docs).toEqual([
    { source_slug: "asai-take-folktales", key: "aa-asai/001", ord: 0, title: "さらわれた娘", row_start: 10, row_end: 12, sentences: 3, translated: 3, text_layer: "modern-orthography-latn@1", text_layer_status: "provisional" },
    { source_slug: "asai-take-folktales", key: "aa-asai/002", ord: 1, title: "神の話", row_start: 13, row_end: 14, sentences: 2, translated: 1, text_layer: "modern-orthography-latn@1", text_layer_status: "provisional" },
    { source_slug: "biratori-ainu-oral-literature", key: "biratori/007", ord: 0, title: "ユㇰ シキ", row_start: 20, row_end: 20, sentences: 1, translated: 1, text_layer: null, text_layer_status: null },
  ]);
});

test("rebuild is idempotent", () => {
  const { sq } = seeded();
  for (const s of TEXT_DOCUMENTS_REBUILD_SQL) sq.run(s);
  expect((sq.query("SELECT count(*) c FROM text_documents").get() as any).c).toBe(3);
});

test("textSources: totals per source, layer only when uniform", async () => {
  const { db } = seeded();
  expect(await textSources(db)).toEqual([
    { source_slug: "asai-take-folktales", documents: 2, sentences: 5, translated: 4, text_layer: "modern-orthography-latn@1", text_layer_status: "provisional" },
    { source_slug: "biratori-ainu-oral-literature", documents: 1, sentences: 1, translated: 1, text_layer: null, text_layer_status: null },
  ]);
});

test("textDocuments: reading order; unknown source is empty", async () => {
  const { db } = seeded();
  const docs = await textDocuments(db, "asai-take-folktales");
  expect(docs.map((d) => [d.key, d.ord, d.title, d.sentences, d.uri])).toEqual([
    ["aa-asai/001", 0, "さらわれた娘", 3, "http://x/at01"],
    ["aa-asai/002", 1, "神の話", 2, "http://x/at02"],
  ]);
  expect(await textDocuments(db, "nope")).toEqual([]);
});

test("textDocument: sentences in order with source spelling and neighbours", async () => {
  const { db } = seeded();
  const page = await textDocument(db, "asai-take-folktales", "aa-asai/001");
  expect(page).not.toBeNull();
  expect(page!.document.key).toBe("aa-asai/001");
  expect(page!.prev).toBeNull();
  expect(page!.next).toEqual({ key: "aa-asai/002", title: "神の話" });
  expect(page!.total).toBe(3);
  expect(page!.offset).toBe(0);
  expect(page!.limit).toBe(TEXT_PAGE_LIMIT_DEFAULT);
  expect(page!.sentences.map((s) => [s.index, s.id, s.text, s.source_text, s.translation])).toEqual([
    [0, "aa-asai/001#0", "haciko monimahpo", "hachiko monimahpo", "さらわれた娘"],
    [1, "aa-asai/001#1", "maas pontara", "maas pontara", "マース"],
    [2, "aa-asai/001#2", "sine kotan", "shine kotan", "ある村"],
  ]);

  const second = await textDocument(db, "asai-take-folktales", "aa-asai/002");
  expect(second!.prev).toEqual({ key: "aa-asai/001", title: "さらわれた娘" });
  expect(second!.next).toBeNull();
  // an empty translation reads as none
  expect(second!.sentences[1]!.translation).toBeNull();
});

test("textDocument: paging stays inside the document and clamps limit", async () => {
  const { db } = seeded();
  const page = await textDocument(db, "asai-take-folktales", "aa-asai/001", { offset: 1, limit: 1 });
  expect(page!.sentences.map((s) => s.index)).toEqual([1]);
  expect(page!.offset).toBe(1);
  expect(page!.limit).toBe(1);
  const beyond = await textDocument(db, "asai-take-folktales", "aa-asai/001", { offset: 99 });
  expect(beyond!.offset).toBe(2);
  expect(beyond!.sentences.map((s) => s.index)).toEqual([2]);
  const huge = await textDocument(db, "asai-take-folktales", "aa-asai/001", { limit: 10_000 });
  expect(huge!.limit).toBe(TEXT_PAGE_LIMIT_MAX);
});

test("textDocument: a document of another source is not found", async () => {
  const { db } = seeded();
  expect(await textDocument(db, "biratori-ainu-oral-literature", "aa-asai/001")).toBeNull();
  expect(await textDocument(db, "asai-take-folktales", "twitter/001")).toBeNull();
});

test("missing schema degrades to empty results", async () => {
  const sq = new Database(":memory:");
  migrate(sq, "0001_tokens.sql", "0005_source_slug.sql", "0006_text_layers.sql");
  const db = d1Of(sq);
  expect(await textSources(db)).toEqual([]);
  expect(await textDocuments(db, "asai-take-folktales")).toEqual([]);
  expect(await textDocument(db, "asai-take-folktales", "aa-asai/001")).toBeNull();
});
