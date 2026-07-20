/**
 * Tests for word-regex search plumbing (src/regex.ts): pattern compilation,
 * LIKE-literal derivation, and vocab-key resolution (SQL shape + JS filter +
 * frequency-ordered cap + per-db memo).
 */
import { test, expect } from "bun:test";
import { BadRegexError, compileWordRegex, requiredLiteral, regexNodeKeys, REGEX_KEY_CAP } from "../src/regex.ts";

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

// ── compileWordRegex ──
test("compileWordRegex: case-insensitive, unanchored", () => {
  const re = compileWordRegex("ech?i");
  expect(re.test("eci")).toBe(true);
  expect(re.test("echi")).toBe(true);
  expect(re.test("hecire")).toBe(true); // unanchored: matches inside the word
  expect(re.test("EchI")).toBe(true);
  expect(re.test("pet")).toBe(false);
});

test("compileWordRegex: anchors restrict to word edges", () => {
  const re = compileWordRegex("^ech?i$");
  expect(re.test("eci")).toBe(true);
  expect(re.test("hecire")).toBe(false);
});

test("compileWordRegex: invalid pattern throws BadRegexError", () => {
  expect(() => compileWordRegex("(")).toThrow(BadRegexError);
  expect(() => compileWordRegex("  ")).toThrow(BadRegexError);
});

test("compileWordRegex: rejects nested-quantifier ReDoS patterns", () => {
  // Catastrophic-backtracking shapes pin the Worker CPU on the vocab scan.
  expect(() => compileWordRegex("(a+)+$")).toThrow(BadRegexError);
  expect(() => compileWordRegex("(a*)*")).toThrow(BadRegexError);
  expect(() => compileWordRegex("([a-z]+)*")).toThrow(BadRegexError);
  expect(() => compileWordRegex("(a+){2,}")).toThrow(BadRegexError);
  // Benign patterns still compile.
  expect(compileWordRegex("(ab)+").test("abab")).toBe(true);
  expect(compileWordRegex("a+").test("aaa")).toBe(true);
});

test("compileWordRegex: rejects overly long patterns", () => {
  expect(() => compileWordRegex("a".repeat(201))).toThrow(BadRegexError);
  expect(() => compileWordRegex("a".repeat(200))).not.toThrow();
});

// ── requiredLiteral ──
test("requiredLiteral: guaranteed literal runs", () => {
  expect(requiredLiteral("ech?i")).toBe("ec");     // h optional → run breaks before it
  expect(requiredLiteral("kamuy.*")).toBe("kamuy");
  expect(requiredLiteral("eci=")).toBe("eci=");
  expect(requiredLiteral("an+re")).toBe("an");     // + keeps the char, breaks adjacency
  expect(requiredLiteral("[ae]ci")).toBe("ci");
});

test("requiredLiteral: bails to '' when nothing is guaranteed", () => {
  expect(requiredLiteral("^a")).toBe("");          // 1-char run doesn't narrow
  expect(requiredLiteral("eci|echi")).toBe("");    // alternation
  expect(requiredLiteral("(ec)hi")).toBe("");      // groups
  expect(requiredLiteral("a{2}b")).toBe("");       // quantified char dropped, 'b' too short
  expect(requiredLiteral("\\barpa")).toBe("arpa"); // escape skipped, literal after it kept
  expect(requiredLiteral("[a\\]bcdef]x")).toBe(""); // escaped ] inside class is not a literal
});

// ── regexNodeKeys ──
test("regexNodeKeys: narrows with LIKE, filters by regex, keeps frequency order", async () => {
  const { db, calls } = fakeDb([
    [{ k: "echi", c: 3208 }, { k: "eci=", c: 2732 }, { k: "pet", c: 100 }, { k: "hecire", c: 46 }],
  ]);
  const keys = await regexNodeKeys(db, "ech?i", "surface_fold");
  expect(calls[0].sql).toContain("GROUP BY k ORDER BY c DESC");
  expect(calls[0].sql).toContain("LIKE ? ESCAPE '\\'");
  expect(calls[0].args).toEqual(["%ec%"]);
  expect(keys).toEqual(["echi", "eci=", "hecire"]); // pet filtered out, order kept
});

test("regexNodeKeys: no guaranteed literal → full vocab scan (no LIKE)", async () => {
  const { db, calls } = fakeDb([[{ k: "arpa", c: 9 }, { k: "kamuy", c: 5 }]]);
  const keys = await regexNodeKeys(db, "^a", "surface_norm");
  expect(calls[0].sql).not.toContain("LIKE");
  expect(calls[0].sql).toContain("surface_norm AS k");
  expect(keys).toEqual(["arpa"]);
});

test("regexNodeKeys: caps at REGEX_KEY_CAP most frequent keys", async () => {
  const vocab = Array.from({ length: REGEX_KEY_CAP + 50 }, (_, i) => ({ k: `aa${i}`, c: 10000 - i }));
  const { db } = fakeDb([vocab]);
  const keys = await regexNodeKeys(db, "^aa", "surface_fold");
  expect(keys.length).toBe(REGEX_KEY_CAP);
  expect(keys[0]).toBe("aa0"); // most frequent survive the cap
});

test("regexNodeKeys: memoized per db instance and pattern", async () => {
  const { db, calls } = fakeDb([[{ k: "echi", c: 1 }]]);
  const a = await regexNodeKeys(db, "ech?i", "surface_fold");
  const b = await regexNodeKeys(db, "ech?i", "surface_fold");
  expect(a).toEqual(b);
  expect(calls.length).toBe(1); // second call served from the memo
});

test("regexNodeKeys: failures are not memoized", async () => {
  let attempt = 0;
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind() { return stmt; },
        async all<T>() {
          if (attempt++ === 0) throw new Error("no such column: surface_fold");
          return { results: [{ k: "echi", c: 1 }] as T[] };
        },
        async first<T>() { return null as T | null; },
      };
      return stmt;
    },
  } as unknown as D1Database;
  await expect(regexNodeKeys(db, "ech?i", "surface_fold")).rejects.toThrow("no such column");
  // retry with the same key succeeds (rejected promise was evicted)
  expect(await regexNodeKeys(db, "ech?i", "surface_fold")).toEqual(["echi"]);
});
