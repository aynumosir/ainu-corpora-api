/**
 * Tests for the structural-pattern parser and the SQL shape of structural()
 * and collocations() (fake D1 records emitted SQL + bound args; no live DB).
 */
import { test, expect } from "bun:test";
import { parsePattern, structural, collocations } from "../src/analysis.ts";

type Call = { sql: string; args: unknown[] };
function fakeDb(queue: any[][] = []) {
  const calls: Call[] = [];
  let i = 0;
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async all<T>() { calls.push({ sql, args }); return { results: (queue[i++] ?? []) as T[] }; },
        async first<T>() { calls.push({ sql, args }); return ((queue[i++] ?? [])[0] ?? null) as T | null; },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, calls };
}

test("parsePattern: bracketed upos/surface/lemma/prefix", () => {
  expect(parsePattern("[upos=VERB]")).toEqual([{ upos: "VERB" }]);
  expect(parsePattern("[surface=arpa]")).toEqual([{ surface: "arpa" }]);
  expect(parsePattern("[lemma=arpa]")).toEqual([{ lemma: "arpa" }]);
  expect(parsePattern("[surface=ku.*]")).toEqual([{ prefix: "ku" }]);
});

test("parsePattern: bare word → surface, bare ALLCAPS → upos, [] → wildcard", () => {
  expect(parsePattern("arpa")).toEqual([{ surface: "arpa" }]);
  expect(parsePattern("VERB")).toEqual([{ upos: "VERB" }]);
  expect(parsePattern("[]")).toEqual([{}]);
});

test("parsePattern: multi-constraint with & and a sequence", () => {
  expect(parsePattern("[upos=NOUN & surface=kamuy]")).toEqual([{ upos: "NOUN", surface: "kamuy" }]);
  const seq = parsePattern("[surface=a=] [] [upos=VERB]");
  expect(seq.length).toBe(3);
  expect(seq[0]).toEqual({ surface: "a=" });
  expect(seq[1]).toEqual({});
  expect(seq[2]).toEqual({ upos: "VERB" });
});

test("parsePattern: folds accents in surface constraints", () => {
  expect(parsePattern("[surface=rámat]")).toEqual([{ surface: "ramat" }]);
});

test("structural: self-joins idx+1 and binds constraints in alias order", async () => {
  const { db, calls } = fakeDb([[]]);
  await structural(db, { pattern: "[upos=NOUN] [upos=NOUN]", limit: 5 });
  expect(calls[0].sql).toContain("JOIN corpus_tokens t1 ON t1.sentence_id = t0.sentence_id AND t1.idx = t0.idx + 1");
  expect(calls[0].args).toEqual(["NOUN", "NOUN", 5]);
});

test("structural: empty pattern → [] with no DB call", async () => {
  const { db, calls } = fakeDb([]);
  expect(await structural(db, { pattern: "   ", limit: 5 })).toEqual([]);
  expect(calls.length).toBe(0);
});

test("structural: all-wildcard refuses to scan", async () => {
  const { db, calls } = fakeDb([]);
  expect(await structural(db, { pattern: "[] []", limit: 5 })).toEqual([]);
  expect(calls.length).toBe(0);
});

test("collocations: empty query → no DB call", async () => {
  const { db, calls } = fakeDb([]);
  const out = await collocations(db, { q: "  ", window: 5, span: "both", minCount: 3, limit: 10, measure: "log_dice" });
  expect(out.collocates).toEqual([]);
  expect(calls.length).toBe(0);
});

test("collocations: window self-join is bounded to ±window and excludes node slot", async () => {
  // queue: [N total], [node rows], [collocate rows] ...
  const { db, calls } = fakeDb([
    [{ c: 1000 }],
    [{ sentence_id: "s1", idx: 2 }],
    [{ token: "ne", upos: "AUX", freq: 5 }],
    [{ f: "ne", c: 50 }],
  ]);
  const out = await collocations(db, { q: "kamuy", window: 3, span: "both", minCount: 1, limit: 10, measure: "log_dice" });
  const colCall = calls.find((c) => c.sql.includes("c.idx BETWEEN"));
  expect(colCall).toBeTruthy();
  expect(colCall!.sql).toContain("c.idx <> t.idx");
  expect(out.collocates.length).toBe(1);
  expect(out.collocates[0].token).toBe("ne");
  expect(typeof out.collocates[0].log_dice).toBe("number");
});
