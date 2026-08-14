import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const stats = JSON.parse(readFileSync(new URL("../public/stats.json", import.meta.url), "utf8"));
const registers = JSON.parse(
  readFileSync(new URL("../data/collection_registers.json", import.meta.url), "utf8"),
);
const slugs = JSON.parse(readFileSync(new URL("../data/collection_slugs.json", import.meta.url), "utf8"));
const page = readFileSync(new URL("../public/stats.html", import.meta.url), "utf8");

const REG_IDS = Object.keys(registers.registers);

describe("collection_registers.json", () => {
  test("every mapped collection points at a defined register", () => {
    for (const [collection, reg] of Object.entries(registers.collections)) {
      expect(REG_IDS, collection).toContain(reg);
    }
  });

  test("every collection with a slug has a register", () => {
    for (const collection of Object.keys(slugs)) {
      expect(registers.collections[collection], collection).toBeDefined();
    }
  });
});

describe("stats.json", () => {
  test("register sentence and word counts sum to the totals", () => {
    const regs = Object.values(stats.registers) as { sentences: number; words: number }[];
    expect(regs.reduce((s, r) => s + r.sentences, 0)).toBe(stats.totals.sentences);
    expect(regs.reduce((s, r) => s + r.words, 0)).toBe(stats.totals.words);
  });

  test("every register carries the per-register datasets", () => {
    for (const [id, r] of Object.entries(stats.registers) as [string, any][]) {
      expect(REG_IDS).toContain(id);
      expect(r.topWords.length, id).toBeGreaterThan(0);
      expect(Array.isArray(r.keywords), id).toBe(true);
      expect(Array.isArray(r.bigrams), id).toBe(true);
      expect(r.lengthHist.length, id).toBe(31);
      expect(Object.keys(r.pos).length, id).toBeGreaterThan(0);
    }
  });

  test("zipf series is rank-ordered and internally consistent", () => {
    expect(stats.zipf[0].w).toBeTruthy();
    for (let i = 1; i < stats.zipf.length; i++) {
      expect(stats.zipf[i].n).toBeLessThanOrEqual(stats.zipf[i - 1].n);
    }
    expect(stats.zipf.reduce((s: number, p: { n: number }) => s + p.n, 0)).toBeLessThanOrEqual(
      stats.totals.words,
    );
  });

  test("collections table covers the corpus and known registers", () => {
    expect(stats.collections.length).toBe(stats.totals.collections);
    expect(stats.collections.reduce((s: number, c: { sentences: number }) => s + c.sentences, 0)).toBe(
      stats.totals.sentences,
    );
    expect(stats.collections.reduce((s: number, c: { words: number }) => s + c.words, 0)).toBe(
      stats.totals.words,
    );
    for (const c of stats.collections) {
      expect(REG_IDS, c.name).toContain(c.register);
      expect(c.meanLength, c.name).toBeGreaterThanOrEqual(0);
    }
  });

  test("length histograms sum to the sentences they cover", () => {
    const sum = (h: number[]) => h.reduce((a, b) => a + b, 0);
    expect(sum(stats.totals.lengthHist)).toBe(stats.totals.sentencesWithWords);
    expect(stats.totals.sentencesWithWords).toBeLessThanOrEqual(stats.totals.sentences);
    for (const [id, r] of Object.entries(stats.registers) as [string, any][]) {
      expect(sum(r.lengthHist), id).toBe(r.sentencesWithWords);
    }
  });

  test("keyness lists respect the significance floor", () => {
    for (const [id, r] of Object.entries(stats.registers) as [string, any][]) {
      for (const k of r.keywords) expect(k.g2, `${id}:${k.w}`).toBeGreaterThanOrEqual(10.83);
    }
  });

  test("samples quote real focus words from their own text", () => {
    expect(stats.samples.length).toBeGreaterThan(0);
    for (const s of stats.samples) {
      expect(REG_IDS).toContain(s.register);
      expect(s.text.toLowerCase()).toContain(s.focus.toLowerCase());
    }
  });
});

describe("slice datasets", () => {
  const slices = Object.fromEntries(
    ["hokkaido", "sakhalin", "traditional", "modern"].map((id) => [
      id,
      JSON.parse(readFileSync(new URL(`../public/stats-${id}.json`, import.meta.url), "utf8")),
    ]),
  );

  test("every slice is internally consistent", () => {
    for (const [id, s] of Object.entries(slices) as [string, any][]) {
      expect(s.slice.id, id).toBe(id);
      const regs = Object.values(s.registers) as { sentences: number; words: number }[];
      expect(regs.reduce((a, r) => a + r.sentences, 0), id).toBe(s.totals.sentences);
      expect(regs.reduce((a, r) => a + r.words, 0), id).toBe(s.totals.words);
      expect(s.totals.sentences, id).toBeLessThanOrEqual(stats.totals.sentences);
      for (const k of s.sliceKeywords) expect(k.g2, `${id}:${k.w}`).toBeGreaterThanOrEqual(10.83);
    }
  });

  test("region slices and era slices stay within the corpus", () => {
    expect(slices.hokkaido.totals.sentences + slices.sakhalin.totals.sentences)
      .toBeLessThanOrEqual(stats.totals.sentences);
    expect(slices.traditional.totals.sentences + slices.modern.totals.sentences)
      .toBeLessThanOrEqual(stats.totals.sentences);
  });

  test("the main dataset's slice index matches the slice files", () => {
    expect(stats.slices.map((s: any) => s.id).sort()).toEqual(Object.keys(slices).sort());
    for (const meta of stats.slices) {
      expect(meta.sentences, meta.id).toBe(slices[meta.id].totals.sentences);
    }
  });

  test("every era-tagged collection has a register mapping", () => {
    for (const name of Object.keys(registers.collectionEras)) {
      expect(registers.collections[name], name).toBeDefined();
    }
  });
});

describe("stats.html", () => {
  test("baked hero numbers match the dataset", () => {
    const baked = [...page.matchAll(/data-n="(\d+)"/g)].map((m) => +m[1]);
    expect(baked).toEqual([
      stats.totals.tokens,
      stats.totals.sentences,
      stats.totals.types,
      stats.totals.collections,
    ]);
    expect(page).toContain(`${stats.totals.hapax.toLocaleString("en-US")} of them occur exactly once`);
  });

  test("the toggle's dark block matches the media-query dark block", () => {
    for (const file of ["../public/stats.html", "../public/index.html"]) {
      const html = readFileSync(new URL(file, import.meta.url), "utf8");
      const decls = (block: string) =>
        [...block.matchAll(/(--[\w-]+|color-scheme)\s*:\s*([^;]+);/g)]
          .map((m) => `${m[1]}:${m[2].trim()}`)
          .sort();
      const media = html.match(
        /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]+)\}/,
      );
      const override = html.match(/:root\[data-theme="dark"\] \{([^}]+)\}/);
      expect(media, file).toBeTruthy();
      expect(override, file).toBeTruthy();
      expect(decls(override![1]), file).toEqual(decls(media![1]));
    }
  });

  test("REG_ORDER covers every register in the dataset", () => {
    const m = page.match(/const REG_ORDER = \[([^\]]+)\]/);
    expect(m).toBeTruthy();
    const order = [...m![1].matchAll(/"(\w+)"/g)].map((x) => x[1]);
    for (const id of Object.keys(stats.registers)) expect(order, id).toContain(id);
    for (const id of order) expect(page).toContain(`--reg-${id}:`);
  });
});
