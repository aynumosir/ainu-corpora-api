/**
 * Tests for the annotated KWIC layer (src/kwic.ts): node-key resolution,
 * accent folding, morphology expansion, per-token windows, and sort modes.
 */
import { test, expect } from "bun:test";
import { kwic, sortLines, type KwicLine } from "../src/kwic.ts";

type Call = { sql: string; args: unknown[] };
/** Fake D1 returning queued result sets in call order. */
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

const tok = (idx: number, surface: string, extra: any = {}) => ({
  sentence_id: extra.sid ?? "s1", idx, surface, surface_norm: surface.toLowerCase(),
  upos: extra.upos ?? null, lemma: extra.lemma ?? null, xpos: extra.xpos ?? null,
  feats_json: extra.feats ?? null, is_clitic: extra.cl ?? 0,
  pos_display: extra.posDisplay ?? null, gloss_en: extra.gloss ?? null, morph_category: extra.morphCategory ?? null,
  alternates: extra.alternates ?? null,
});

test("fold match binds the folded key, exact binds surface_norm", async () => {
  const { db, calls } = fakeDb([[]]);
  await kwic(db, { q: "Rámat", ctx: 2, limit: 5, sort: "none", match: "fold", expand: "none" });
  // fold path resolves keys first (morph lookup skipped for expand=none) then node query.
  const nodeCall = calls.find((c) => c.sql.includes("surface_fold IN"));
  expect(nodeCall).toBeTruthy();
  expect(nodeCall!.args).toContain("ramat");

  const { db: db2, calls: c2 } = fakeDb([[]]);
  await kwic(db2, { q: "Rámat", ctx: 2, limit: 5, sort: "none", match: "exact", expand: "none" });
  expect(c2[0].sql).toContain("t.surface_norm = ?");
  expect(c2[0].args[0]).toBe("rámat");
});

test("prefix match uses folded LIKE", async () => {
  const { db, calls } = fakeDb([[]]);
  await kwic(db, { q: "kamuy", ctx: 2, limit: 5, sort: "none", match: "prefix", expand: "none" });
  expect(calls[0].sql).toContain("t.surface_fold LIKE ? ESCAPE '\\'");
  expect(calls[0].args[0]).toBe("kamuy%");
});

test("expand=plural pulls morph_forms then matches the union of keys", async () => {
  const { db, calls } = fakeDb([
    [{ lemma_fold: "arpa", surface_fold: "paye" }], // morph lookup
    [], // node query
  ]);
  await kwic(db, { q: "arpa", ctx: 2, limit: 5, sort: "none", match: "fold", expand: "plural" });
  expect(calls[0].sql).toContain("FROM morph_forms");
  expect(calls[0].sql).toContain("relation = 'plural'");
  const nodeCall = calls.find((c) => c.sql.includes("surface_fold IN"));
  expect(nodeCall!.args).toContain("arpa");
  expect(nodeCall!.args).toContain("paye");
});

test("node upos + clitic + dialect constraints are appended", async () => {
  const { db, calls } = fakeDb([[]]);
  await kwic(db, { q: "arpa", ctx: 2, limit: 5, sort: "none", match: "exact", expand: "none",
    nodeUpos: "verb", clitic: "exclude", dialect: "沙流" });
  expect(calls[0].sql).toContain("t.upos = ?");
  expect(calls[0].sql).toContain("t.is_clitic = 0");
  expect(calls[0].sql).toContain("instr(s.dialect, ?) > 0");
  expect(calls[0].sql).toContain("LIMIT ? OFFSET ?");
  expect(calls[0].args).toEqual(["arpa", "VERB", "沙流", 5, 0]); // …limit, offset
});

test("builds per-token left/node/right windows from sentence tokens", async () => {
  // node 'arpa' at idx 2 of "ku = arpa wa an"
  const node = { sentence_id: "s1", idx: 2, char_start: 3, char_end: 7,
    text: "ku=arpa wa an", translation: "I go and...", dialect: null, author: null, uri: null };
  const sentToks = [tok(0, "ku", { cl: 1 }), tok(1, "=", {}), tok(2, "arpa", { upos: "VERB" }), tok(3, "wa"), tok(4, "an")];
  const { db } = fakeDb([[node], sentToks]);
  const out = await kwic(db, { q: "arpa", ctx: 2, limit: 5, sort: "none", match: "exact", expand: "none" });
  expect(out.length).toBe(1);
  expect(out[0].node[0].s).toBe("arpa");
  expect(out[0].node[0].node).toBe(true);
  expect(out[0].node[0].p).toBe("VERB");
  expect(out[0].left.map((t) => t.s)).toEqual(["ku", "="]);
  expect(out[0].right.map((t) => t.s)).toEqual(["wa", "an"]);
  expect(out[0].node_text).toBe("arpa");
});

test("morpheme DB gloss row overrides display POS and adds gloss", async () => {
  // Raw tagger says PART, morpheme DB says personal clitic => display PERS + 4.A=.
  const node = { sentence_id: "s1", idx: 0, char_start: 0, char_end: 2,
    text: "a=rayke", translation: null, dialect: null, author: null, uri: null };
  const sentToks = [
    tok(0, "a=", { upos: "PART", posDisplay: "PERS", gloss: "4.A=", morphCategory: "pers", cl: 1 }),
    tok(1, "rayke", { upos: "VERB", gloss: "kill", morphCategory: "vt" }),
  ];
  const { db } = fakeDb([[node], sentToks]);
  const out = await kwic(db, { q: "a=", ctx: 1, limit: 5, sort: "none", match: "exact", expand: "none" });
  expect(out[0].node[0].s).toBe("a=");
  expect(out[0].node[0].p).toBe("PERS");
  expect(out[0].node[0].u).toBe("PART");
  expect(out[0].node[0].g).toBe("4.A=");
  expect(out[0].node[0].mc).toBe("pers");
  expect(out[0].right[0].p).toBe("VERB");
  expect(out[0].right[0].g).toBe("kill");
});

test("homograph alternates parse into the token's alt array", async () => {
  const node = { sentence_id: "s1", idx: 0, char_start: 0, char_end: 2,
    text: "pa", translation: null, dialect: null, author: null, uri: null };
  const sentToks = [
    tok(0, "pa", { upos: "NOUN", posDisplay: "NOUN", gloss: "head", morphCategory: "n",
      alternates: JSON.stringify([{ p: null, g: "PL", mc: "sfx" }, { p: "NOUN", g: "mouth", mc: "n" }]) }),
  ];
  const { db } = fakeDb([[node], sentToks]);
  const out = await kwic(db, { q: "pa", ctx: 1, limit: 5, sort: "none", match: "exact", expand: "none" });
  const t = out[0].node[0];
  expect(t.g).toBe("head");
  expect(t.alt?.length).toBe(2);
  expect(t.alt?.[0]).toEqual({ p: null, g: "PL", mc: "sfx" });
  expect(t.alt?.[1].g).toBe("mouth");
});

test("token without alternates has no alt field", async () => {
  const node = { sentence_id: "s1", idx: 0, char_start: 0, char_end: 5,
    text: "rayke", translation: null, dialect: null, author: null, uri: null };
  const sentToks = [tok(0, "rayke", { upos: "VERB", gloss: "kill", morphCategory: "vt" })];
  const { db } = fakeDb([[node], sentToks]);
  const out = await kwic(db, { q: "rayke", ctx: 1, limit: 5, sort: "none", match: "exact", expand: "none" });
  expect(out[0].node[0].alt).toBeUndefined();
});

test("KWIC degrades gracefully when the morph_gloss join is unavailable", async () => {
  // Older DB without the morph_gloss table / alternates column: the gloss join
  // throws, the loader falls back to a plain corpus_tokens query, KWIC still works.
  const node = { sentence_id: "s1", idx: 0, char_start: 0, char_end: 5,
    text: "rayke", translation: null, dialect: null, author: null, uri: null };
  const fallbackTok = { sentence_id: "s1", idx: 0, surface: "rayke", surface_norm: "rayke",
    upos: "VERB", lemma: null, xpos: null, feats_json: null, is_clitic: 0 };
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async all<T>() {
          if (sql.includes("morph_gloss")) throw new Error("no such column: alternates");
          const rows = sql.includes("FROM corpus_tokens WHERE sentence_id IN") ? [fallbackTok] : [node];
          return { results: rows as T[] };
        },
        async first<T>() { return null as T | null; },
      };
      return stmt;
    },
  } as unknown as D1Database;
  const out = await kwic(db, { q: "rayke", ctx: 1, limit: 5, sort: "none", match: "exact", expand: "none" });
  expect(out[0].node[0].s).toBe("rayke");
  expect(out[0].node[0].p).toBe("VERB"); // falls back to raw UPOS
  expect(out[0].node[0].g ?? null).toBeNull(); // gloss absent, but no crash
  expect(out[0].node[0].alt).toBeUndefined();
});

test("standalone glottal-stop markers are skipped in KWIC context windows", async () => {
  // Reproduces the Murasaki Sakhalin case: "' ampa teh ' ahun ' isam ' isam '"
  // where bare "'" tokens are glottal-stop markers, not words. They must NOT
  // fill the left/right context (the "' isam '" noise the user reported).
  // node 'isam' is at idx 7.
  const node = { sentence_id: "s1", idx: 7, char_start: 0, char_end: 4,
    text: "ampa teh ahun isam isam omantene", translation: null, dialect: null, author: null, uri: null };
  const sentToks = [
    tok(0, "'"), tok(1, "ampa"), tok(2, "teh"), tok(3, "'"), tok(4, "ahun"),
    tok(5, "'"), tok(6, "isam"), tok(7, "isam", { upos: "VERB" }), tok(8, "'"),
    tok(9, "omantene"), tok(10, "'"),
  ];
  const { db } = fakeDb([[node], sentToks]);
  const out = await kwic(db, { q: "isam", ctx: 3, limit: 5, sort: "none", match: "exact", expand: "none" });
  expect(out.length).toBe(1);
  // left: skip the "'" at idx 6's neighbours — real words only, nearest 3.
  expect(out[0].left.map((t) => t.s)).toEqual(["teh", "ahun", "isam"]);
  expect(out[0].right.map((t) => t.s)).toEqual(["omantene"]);
  // none of the context tokens is a bare apostrophe marker
  expect([...out[0].left, ...out[0].right].some((t) => t.s === "'")).toBe(false);
});

// ── sortLines (pure) ──
const line = (left: string[], node: string, right: string[], extra: any = {}): KwicLine => ({
  sentence_id: extra.sid ?? "s",
  left: left.map((n, i) => ({ i, s: n, n, p: null, l: null, x: null, f: null, cl: 0 })),
  node: [{ i: 99, s: node, n: node, p: null, l: null, x: null, f: null, cl: 0, node: true }],
  right: right.map((n, i) => ({ i, s: n, n, p: null, l: null, x: null, f: null, cl: 0 })),
  left_text: left.join(" "), node_text: node, right_text: right.join(" "),
  translation: null, dialect: extra.dia ?? null, author: null, uri: null, source_slug: null,
});

test("sort r1 orders by first right token", () => {
  const ls = [line([], "x", ["zeta"], { sid: "a" }), line([], "x", ["alpha"], { sid: "b" })];
  sortLines(ls, "r1");
  expect(ls.map((l) => l.sentence_id)).toEqual(["b", "a"]);
});

test("sort l1 orders by nearest left token", () => {
  const ls = [line(["far", "zeta"], "x", [], { sid: "a" }), line(["far", "alpha"], "x", [], { sid: "b" })];
  sortLines(ls, "l1");
  expect(ls.map((l) => l.sentence_id)).toEqual(["b", "a"]);
});

test("sort dialect orders by dialect string", () => {
  const ls = [line([], "x", [], { sid: "a", dia: "沙流" }), line([], "x", [], { sid: "b", dia: "千歳" })];
  sortLines(ls, "dialect");
  expect(ls[0].dialect).toBeTruthy();
});

test("KWIC lines carry source_slug from the sentences lookup", async () => {
  const node = { sentence_id: "s1", idx: 0, char_start: 0, char_end: 5,
    text: "rayke", translation: null, dialect: null, author: null, uri: null };
  const sentToks = [tok(0, "rayke", { upos: "VERB" })];
  const { db, calls } = fakeDb([[node], sentToks, [{ id: "s1", source_slug: "ainu-audio-materials" }]]);
  const out = await kwic(db, { q: "rayke", ctx: 1, limit: 5, sort: "none", match: "exact", expand: "none" });
  expect(calls[2].sql).toContain("SELECT id, source_slug FROM sentences");
  expect(out[0].source_slug).toBe("ainu-audio-materials");
});

test("KWIC source_slug is null when the sentence has no registered source", async () => {
  const node = { sentence_id: "s1", idx: 0, char_start: 0, char_end: 5,
    text: "rayke", translation: null, dialect: null, author: null, uri: null };
  const sentToks = [tok(0, "rayke", { upos: "VERB" })];
  const { db } = fakeDb([[node], sentToks, []]);
  const out = await kwic(db, { q: "rayke", ctx: 1, limit: 5, sort: "none", match: "exact", expand: "none" });
  expect(out[0].source_slug).toBeNull();
});
