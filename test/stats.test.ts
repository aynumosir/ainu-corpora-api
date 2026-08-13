import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const stats = JSON.parse(readFileSync(new URL("../public/stats.json", import.meta.url), "utf8"));
const registers = JSON.parse(
  readFileSync(new URL("../data/collection_registers.json", import.meta.url), "utf8"),
);
const slugs = JSON.parse(readFileSync(new URL("../data/collection_slugs.json", import.meta.url), "utf8"));

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
    for (const c of stats.collections) expect(REG_IDS, c.name).toContain(c.register);
  });

  test("samples quote real focus words from their own text", () => {
    expect(stats.samples.length).toBeGreaterThan(0);
    for (const s of stats.samples) {
      expect(REG_IDS).toContain(s.register);
      expect(s.text.toLowerCase()).toContain(s.focus.toLowerCase());
    }
  });
});
