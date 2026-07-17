/**
 * Curated gloss read helpers (src/gloss.ts) against an in-memory SQLite DB
 * shaped by migrations/0006_curated_gloss.sql — grouping, JSON-column
 * parsing, coverage aggregation, and the missing-schema grace path that
 * keeps deploys safe before the first data load.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { glossForSentence, glossCoverage } from "../src/gloss.ts";

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

function seeded(): D1Database {
  const sq = new Database(":memory:");
  const mig = readFileSync(new URL("../migrations/0006_curated_gloss.sql", import.meta.url), "utf8");
  sq.run(mig.replace(/--.*$/gm, ""));
  sq.run(
    `INSERT INTO gloss_layers (id, credibility, language, status, author, origin_url, origin_title)
     VALUES ('hokudai-respect-gloss', 'curated', 'ja', 'provisional', 'mkpoli',
             'https://note.com/mkpoli/n/ncaf160e441a3', '解読記事')`,
  );
  sq.run(
    `INSERT INTO curated_gloss (layer_id, sentence_id, part_idx, ain, gloss, interp, aligned, pairs, notes, divergence) VALUES
     ('hokudai-respect-gloss', 'hokudai-respect/summary#8', 0, '2026 pa 3 cup 北海道大学', '2026 年 3 月 PROPN', '2026年3月 北海道大学', 1,
      '[["2026","2026"],["pa","年"],["3","3"],["cup","月"],["北海道大学","PROPN"]]', NULL, NULL),
     ('hokudai-respect-gloss', 'hokudai-respect/full#17', 0, 'a b', 'g1 g2', NULL, 1, '[["a","g1"],["b","g2"]]', '[{"topic":"pronunciation"}]', NULL),
     ('hokudai-respect-gloss', 'hokudai-respect/full#17', 1, 'long sentence', 'unaligned gloss line', 'reading', 0, NULL, NULL, NULL)`,
  );
  return d1Of(sq);
}

test("glossForSentence groups parts under the layer with provenance inlined", async () => {
  const db = seeded();
  const got = await glossForSentence(db, "hokudai-respect/full#17");
  expect(got.sentence_id).toBe("hokudai-respect/full#17");
  expect(got.layers.length).toBe(1);
  const layer = got.layers[0]!;
  expect(layer.id).toBe("hokudai-respect-gloss");
  expect(layer.credibility).toBe("curated");
  expect(layer.author).toBe("mkpoli");
  expect(layer.origin_url).toContain("note.com");
  expect(layer.parts.map((p) => p.part)).toEqual([0, 1]);
  expect(layer.parts[0]!.aligned).toBe(true);
  expect(layer.parts[0]!.pairs).toEqual([["a", "g1"], ["b", "g2"]]);
  expect(layer.parts[0]!.notes).toEqual([{ topic: "pronunciation" }]);
  expect(layer.parts[1]!.aligned).toBe(false);
  expect(layer.parts[1]!.pairs).toBeNull();
  expect(layer.parts[1]!.interp).toBe("reading");
});

test("glossForSentence: uncovered sentence -> empty layers", async () => {
  const got = await glossForSentence(seeded(), "bible/jon/001#0");
  expect(got.layers).toEqual([]);
});

test("glossCoverage aggregates documents per layer", async () => {
  const got = await glossCoverage(seeded());
  expect(got.layers.length).toBe(1);
  const layer = got.layers[0]!;
  expect(layer.id).toBe("hokudai-respect-gloss");
  expect(layer.documents).toEqual([
    { document: "hokudai-respect/full", sentences: 1 },
    { document: "hokudai-respect/summary", sentences: 1 },
  ]);
  expect(layer.sentences).toBe(2);
});

test("missing schema degrades to empty results (pre-load deploy safety)", async () => {
  const bare = d1Of(new Database(":memory:"));
  expect(await glossForSentence(bare, "x#0")).toEqual({ sentence_id: "x#0", layers: [] });
  expect(await glossCoverage(bare)).toEqual({ layers: [] });
});
