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

test("parsePattern: /re/ slots, bare and bracketed", () => {
  expect(parsePattern("/ech?i/ /^a/")).toEqual([{ regex: "ech?i" }, { regex: "^a" }]);
  expect(parsePattern("[surface=/ech?i/]")).toEqual([{ regex: "ech?i" }]);
  expect(parsePattern("/^si/ VERB")).toEqual([{ regex: "^si" }, { upos: "VERB" }]);
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

test("structural: regex slots resolve to key IN-lists per position", async () => {
  const { db, calls } = fakeDb([
    [{ k: "echi", c: 10 }, { k: "eci=", c: 5 }, { k: "pet", c: 3 }], // vocab for /ech?i/
    [{ k: "an", c: 100 }, { k: "arpa", c: 50 }, { k: "pet", c: 3 }], // vocab for /^a/
    [], // main join query
  ]);
  await structural(db, { pattern: "/ech?i/ /^a/", limit: 5 });
  const main = calls[2];
  expect(main.sql).toContain("t0.surface_fold IN (?,?)");
  expect(main.sql).toContain("t1.surface_fold IN (?,?)");
  expect(main.args).toEqual(["echi", "eci=", "an", "arpa", 5]);
});

test("structural: regex slot with no vocab match → [] without the main query", async () => {
  const { db, calls } = fakeDb([[{ k: "pet", c: 3 }]]);
  expect(await structural(db, { pattern: "/zzz/ wa", limit: 5 })).toEqual([]);
  expect(calls.length).toBe(1); // only the vocab scan ran
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
