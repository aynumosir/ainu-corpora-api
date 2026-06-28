/**
 * Golden parity tests for the lifted corpus query layer.
 *
 * No live DB: a fake D1 records the exact SQL + bound args each helper emits,
 * so we assert the extraction is byte-identical to ainu-mcp's db.ts. If any of
 * these SQL strings drift, the MCP behaviour would change — which the whole
 * "Phase 0 is a pure refactor" claim depends on NOT happening.
 */
import { test, expect } from "bun:test";
import {
  corpusSearch,
  tokenFrequency,
  frequencyList,
  stopwordsList,
  isStopword,
  vocabCandidates,
  getMeta,
} from "../src/db.ts";

type Call = { sql: string; args: unknown[] };

/** Fake D1 that records calls and returns queued result sets. */
function fakeDb(queue: any[][] = []) {
  const calls: Call[] = [];
  let i = 0;
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) {
          args = a;
          return stmt;
        },
        async all<T>() {
          calls.push({ sql, args });
          return { results: (queue[i++] ?? []) as T[] };
        },
        async first<T>() {
          calls.push({ sql, args });
          return ((queue[i++] ?? [])[0] ?? null) as T | null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, calls };
}

test("corpusSearch: >=3 chars uses FTS MATCH with phrase + rowid order + clamped limit", async () => {
  const { db, calls } = fakeDb([[]]);
  await corpusSearch(db, { query: "rayke", lang: "ain", limit: 5 });
  expect(calls[0].sql).toContain("FROM corpus_fts");
  expect(calls[0].sql).toContain("corpus_fts MATCH ?");
  expect(calls[0].sql).toContain("ORDER BY rowid LIMIT ?");
  expect(calls[0].args).toEqual([`text : "rayke"`, 5]);
});

test("corpusSearch: any-lang uses unscoped phrase", async () => {
  const { db, calls } = fakeDb([[]]);
  await corpusSearch(db, { query: "kamuy", lang: "any", limit: 20 });
  expect(calls[0].args[0]).toBe(`"kamuy"`);
});

test("corpusSearch: <3 chars falls back to bounded LIKE scan (case-insensitive)", async () => {
  const { db, calls } = fakeDb([[]]);
  await corpusSearch(db, { query: "an", lang: "ain", limit: 3 });
  expect(calls[0].sql).toContain("lower(text) LIKE ? ESCAPE '\\'");
  expect(calls[0].args).toEqual(["%an%", 3]);
});

test("corpusSearch: dialect + author add instr() filters", async () => {
  const { db, calls } = fakeDb([[]]);
  await corpusSearch(db, { query: "sirepa", lang: "any", dialect: "樺太", author: "知里", limit: 10 });
  expect(calls[0].sql).toContain("instr(dialect, ?) > 0");
  expect(calls[0].sql).toContain("instr(author, ?) > 0");
  expect(calls[0].args).toEqual([`"sirepa"`, "樺太", "知里", 10]);
});

test("corpusSearch: empty query short-circuits to [] with no DB call", async () => {
  const { db, calls } = fakeDb();
  expect(await corpusSearch(db, { query: "  ", lang: "any", limit: 5 })).toEqual([]);
  expect(calls.length).toBe(0);
});

test("corpusSearch: negative limit is clamped to 0 (never LIMIT -1)", async () => {
  const { db, calls } = fakeDb([[]]);
  await corpusSearch(db, { query: "kamuy", lang: "any", limit: -1 });
  expect(calls[0].args[calls[0].args.length - 1]).toBe(0);
});

test("tokenFrequency: returns count, stopword flag, and 1-based rank", async () => {
  const { db } = fakeDb([[{ count: 42, is_stopword: 0 }], [{ c: 7 }]]);
  const r = await tokenFrequency(db, "rayke");
  expect(r).toEqual({ count: 42, is_stopword: false, rank: 8 });
});

test("tokenFrequency: unknown token → null", async () => {
  const { db } = fakeDb([[]]);
  expect(await tokenFrequency(db, "zzz")).toBeNull();
});

test("frequencyList: excludes stopwords by default", async () => {
  const { db, calls } = fakeDb([[]]);
  await frequencyList(db, { limit: 10, offset: 0, includeStopwords: false, minCount: 1 });
  expect(calls[0].sql).toContain("is_stopword = 0");
  expect(calls[0].sql).toContain("ORDER BY count DESC, rowid");
});

test("frequencyList: includeStopwords drops the is_stopword filter", async () => {
  const { db, calls } = fakeDb([[]]);
  await frequencyList(db, { limit: 10, offset: 5, includeStopwords: true, minCount: 2 });
  expect(calls[0].sql).not.toContain("is_stopword = 0");
  expect(calls[0].args).toEqual([2, 10, 5]);
});

test("stopwordsList: source order, mapped to strings", async () => {
  const { db } = fakeDb([[{ word: "wa" }, { word: "ne" }]]);
  expect(await stopwordsList(db)).toEqual(["wa", "ne"]);
});

test("isStopword: matches normalized column", async () => {
  const { db, calls } = fakeDb([[{ x: 1 }]]);
  expect(await isStopword(db, "wa")).toBe(true);
  expect(calls[0].sql).toContain("WHERE normalized = ?");
});

test("vocabCandidates: count>=min, count DESC", async () => {
  const { db, calls } = fakeDb([[]]);
  await vocabCandidates(db, 5);
  expect(calls[0].sql).toContain("WHERE count >= ?");
  expect(calls[0].sql).toContain("ORDER BY count DESC, rowid");
  expect(calls[0].args).toEqual([5]);
});

test("getMeta: reads value by key", async () => {
  const { db } = fakeDb([[{ value: "{\"sentences\":196184}" }]]);
  expect(await getMeta(db, "corpus_stats")).toBe('{"sentences":196184}');
});
