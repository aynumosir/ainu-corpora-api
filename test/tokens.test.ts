/**
 * Phase 2 — concordance (KWIC) tests. A fake D1 returns canned token+sentence
 * rows; we assert the SQL shape and the JS offset-slicing + context sorting.
 */
import { test, expect } from "bun:test";
import { concordance, posSearch } from "../src/tokens.ts";

type Call = { sql: string; args: unknown[] };
function fakeDb(rows: any[]) {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async all<T>() { calls.push({ sql, args }); return { results: rows as T[] }; },
        async first<T>() { calls.push({ sql, args }); return (rows[0] ?? null) as T | null; },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, calls };
}

const row = (text: string, a: number, b: number, extra: any = {}) => ({
  sentence_id: extra.id ?? "s1", text, translation: extra.tr ?? null,
  dialect: extra.dia ?? null, author: extra.au ?? null, uri: extra.uri ?? null, a, b,
});

test("exact match: left/node/right sliced by offset (real sentence)", async () => {
  // "néa pon yuk a=rayke akusu," — node 'rayke' at chars 14..19, window 6
  const { db, calls } = fakeDb([row("néa pon yuk a=rayke akusu,", 14, 19)]);
  const out = await concordance(db, { q: "rayke", window: 6, limit: 10, sort: "none", match: "exact" });
  expect(calls[0].sql).toContain("t.surface_norm = ?");
  expect(calls[0].args[0]).toBe("rayke");
  expect(out[0].left).toBe("yuk a=");
  expect(out[0].node).toBe("rayke");
  expect(out[0].right).toBe(" akusu");
});

test("window slicing is exact", async () => {
  const { db } = fakeDb([row("0123456789NODE0123456789", 10, 14)]);
  const out = await concordance(db, { q: "node", window: 4, limit: 10, sort: "none", match: "exact" });
  expect(out[0].left).toBe("6789");
  expect(out[0].node).toBe("NODE");
  expect(out[0].right).toBe("0123");
});

test("prefix match uses LIKE with escaped wildcard", async () => {
  const { db, calls } = fakeDb([]);
  await concordance(db, { q: "ray", window: 4, limit: 5, sort: "none", match: "prefix" });
  expect(calls[0].sql).toContain("t.surface_norm LIKE ? ESCAPE '\\'");
  expect(calls[0].args[0]).toBe("ray%");
});

test("dialect + author add instr filters and bind in order", async () => {
  const { db, calls } = fakeDb([]);
  await concordance(db, { q: "rayke", window: 4, limit: 5, sort: "none", match: "exact", dialect: "沙流", author: "川上" });
  expect(calls[0].sql).toContain("instr(s.dialect, ?) > 0");
  expect(calls[0].sql).toContain("instr(s.author, ?) > 0");
  expect(calls[0].args).toEqual(["rayke", "沙流", "川上", 5]);
});

test("empty query → [] with no DB call", async () => {
  const { db, calls } = fakeDb([]);
  expect(await concordance(db, { q: "  ", window: 4, limit: 5, sort: "none", match: "exact" })).toEqual([]);
  expect(calls.length).toBe(0);
});

test("sort=right orders by right context", async () => {
  const { db } = fakeDb([
    row("xx NODE zzz", 3, 7, { id: "a" }),
    row("xx NODE aaa", 3, 7, { id: "b" }),
  ]);
  const out = await concordance(db, { q: "node", window: 5, limit: 10, sort: "right", match: "exact" });
  expect(out.map((l) => l.sentence_id)).toEqual(["b", "a"]); // " aaa" < " zzz"
});

test("sort=left orders by reversed left context (nearest char first)", async () => {
  const { db } = fakeDb([
    row("zb NODE", 3, 7, { id: "a" }),   // left "zb" → reversed "bz"
    row("za NODE", 3, 7, { id: "b" }),   // left "za" → reversed "az"
  ]);
  const out = await concordance(db, { q: "node", window: 5, limit: 10, sort: "left", match: "exact" });
  expect(out.map((l) => l.sentence_id)).toEqual(["b", "a"]); // "az" < "bz"
});

// ───────── posSearch ─────────
const posRow = (text: string, a: number, b: number, x: any = {}) => ({
  sentence_id: x.id ?? "s1", text, translation: null, dialect: null, author: null, uri: null,
  a, b, upos: x.upos ?? null, lemma: x.lemma ?? null, nb: x.nb ?? null,
});

test("posSearch: upos filter uppercases and binds; no adjacency join", async () => {
  const { db, calls } = fakeDb([]);
  await posSearch(db, { upos: "verb", window: 10, limit: 5 });
  expect(calls[0].sql).toContain("t.upos = ?");
  expect(calls[0].sql).not.toContain("JOIN corpus_tokens n");
  expect(calls[0].args).toEqual(["VERB", 5]);
});

test("posSearch: adjacency 'VERB followed by =an' self-joins idx+1", async () => {
  const { db, calls } = fakeDb([]);
  await posSearch(db, { upos: "VERB", nextSurface: "=an", window: 10, limit: 5 });
  expect(calls[0].sql).toContain("JOIN corpus_tokens n ON n.sentence_id = t.sentence_id AND n.idx = t.idx + 1");
  expect(calls[0].sql).toContain("n.surface_norm = ?");
  expect(calls[0].args).toEqual(["VERB", "=an", 5]);
});

test("posSearch: no filters → [] with no DB call", async () => {
  const { db, calls } = fakeDb([]);
  expect(await posSearch(db, { window: 10, limit: 5 })).toEqual([]);
  expect(calls.length).toBe(0);
});

test("posSearch: node window spans node..neighbour when adjacency used", async () => {
  // "ku=arpa =an na" — node 'arpa' 3..7, neighbour '=an' ends at 11
  const { db } = fakeDb([posRow("ku=arpa =an na", 3, 7, { upos: "VERB", nb: 11 })]);
  const out = await posSearch(db, { upos: "VERB", nextSurface: "=an", window: 3, limit: 5 });
  expect(out[0].node).toBe("arpa =an");
  expect(out[0].left).toBe("ku=");
  expect(out[0].right).toBe(" na");
  expect(out[0].upos).toBe("VERB");
});
