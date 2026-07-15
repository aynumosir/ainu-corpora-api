import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectUnseededWords, writeUnseededWords } from "../scripts/export_unseeded_words.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "unseeded-words-"));
  dirs.push(dir);
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sentences (
      id TEXT PRIMARY KEY, row_order INTEGER, text TEXT, translation TEXT,
      collection TEXT, document TEXT, dialect TEXT, dialect_path TEXT,
      region TEXT, uri TEXT, source_slug TEXT
    );
    CREATE TABLE corpus_tokens (
      sentence_id TEXT, idx INTEGER, surface TEXT, surface_norm TEXT,
      surface_fold TEXT, script TEXT, is_clitic INTEGER, lemma TEXT, upos TEXT,
      char_start INTEGER DEFAULT 0, char_end INTEGER DEFAULT 0
    );
    CREATE TABLE morph_gloss (
      key_fold TEXT PRIMARY KEY, gloss_en TEXT, gloss_jp TEXT
    );
    CREATE TABLE morph_forms (
      surface_fold TEXT, lemma_fold TEXT
    );
  `);
  const sentence = db.prepare(`INSERT INTO sentences VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  sentence.run("s1", 1, "a= ysamka ysamka aysamka uweomare macihi unknown", "first", "C1", "D1", "Saru", "北海道/南西/沙流", "北海道", "u1", "src1");
  sentence.run("s2", 2, "unknown surfaceform", "second", "C2", "D2", "Chitose", "北海道/南西/千歳", "北海道", "u2", "src2");
  const token = db.prepare(`
    INSERT INTO corpus_tokens
      (sentence_id, idx, surface, surface_norm, surface_fold, script, is_clitic, lemma, upos)
    VALUES (?, ?, ?, ?, ?, 'latn', ?, ?, ?)
  `);
  token.run("s1", 0, "a=", "a=", "a=", 1, "a=", "PART");
  token.run("s1", 1, "ysamka", "ysamka", "ysamka", 0, "ysamka", "VERB");
  token.run("s1", 2, "ysamka", "ysamka", "ysamka", 0, "ysamka", "VERB");
  token.run("s1", 3, "aysamka", "aysamka", "aysamka", 0, "aysamka", "VERB");
  token.run("s1", 4, "uweomare", "uweomare", "uweomare", 0, "uweomare", "VERB");
  token.run("s1", 5, "macihi", "macihi", "macihi", 0, "macihi", "NOUN");
  token.run("s1", 6, "unknown", "unknown", "unknown", 0, "unknown", "NOUN");
  token.run("s2", 0, "unknown", "unknown", "unknown", 0, "unknown", "NOUN");
  token.run("s2", 1, "surfaceform", "surfaceform", "surfaceform", 0, "known", "VERB");
  db.exec(`
    INSERT INTO morph_gloss VALUES ('isamka', 'vanish', NULL);
    INSERT INTO morph_gloss VALUES ('ueomare', 'put together', NULL);
    INSERT INTO morph_gloss VALUES ('mat', 'woman', NULL);
    INSERT INTO morph_gloss VALUES ('known', 'know', NULL);
    INSERT INTO morph_forms VALUES ('macihi', 'mat');
  `);
  return { db, dir };
}

const registry = {
  lexical: [{ canonical: "ueomare", variants: ["uweomare"], match: "exact" }],
  conditioned_rules: [{ id: "person-prefix-vowel-glide", condition: "person_prefix", prefixes: ["a", "ku"] }],
  conditioned: [{ canonical: "isamka", surface: "ysamka", rule: "person-prefix-vowel-glide" }],
};

test("exports only forms that remain unresolved after every licensed lookup", () => {
  const { db } = fixture();
  const reviews = new Map([["unknown", { disposition: "lexical_candidate", evidence: "fixture" }]]);
  const result = collectUnseededWords({ db, registry, reviews, minCount: 1, minCollections: 1, limit: 10 });

  expect(result.words.map((word) => [word.form, word.occurrences])).toEqual([
    ["unknown", 2],
    ["ysamka", 1],
  ]);
  expect(result.words[0].collection_count).toBe(2);
  expect(result.words[0].contexts).toHaveLength(2);
  expect(result.words[0].review_disposition).toBe("lexical_candidate");
  expect(result.words[0].evidence).toBe("fixture");
  expect(result.resolutions).toEqual({ lexical_equivalence: 1, conditioned_form: 2, tagger_lemma: 1 });
  db.close();
});

test("cross-collection filtering and TSV output are deterministic", () => {
  const { db, dir } = fixture();
  const result = collectUnseededWords({ db, registry, minCount: 2, minCollections: 2, limit: 10 });
  const first = join(dir, "first.tsv");
  const second = join(dir, "second.tsv");
  const metadata = { corpus_sentences: 2, corpus_tokens: 9, equivalences_sha256: "test", reviews_sha256: "review" };

  writeUnseededWords(first, result, metadata);
  writeUnseededWords(second, result, metadata);

  expect(readFileSync(first, "utf8")).toBe(readFileSync(second, "utf8"));
  expect(readFileSync(first, "utf8")).toContain("\n1\tunknown\t2\t2\t2\t1\t");
  db.close();
});
