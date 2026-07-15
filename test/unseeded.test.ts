import { expect, test } from "bun:test";
import { parseUnseededWords, selectUnseededWords } from "../src/unseeded.ts";

const HEADER = [
  "rank", "form", "lookup_status", "canonical_candidates", "occurrences",
  "collection_count", "dialect_count", "region_count", "surfaces", "collections",
  "dialects", "dialect_paths", "regions", "tagger_lemmas", "tagger_pos",
  "review_disposition", "suggested_parse", "evidence", "note", "contexts",
].join("\t");

function quoted(value: unknown): string {
  return `"${JSON.stringify(value).replaceAll('"', '""')}"`;
}

function row(rank: number, form: string, status: string, count: number, region: string) {
  return [
    rank, form, status, quoted(status === "tagger_lemma_suggestion" ? [{ value: "eci=", count }] : []), count,
    2, 2, 1, quoted([form]), quoted(["A", "B"]), quoted(["Saru", "Chitose"]),
    quoted([`北海道/南西/${region}`]), quoted([region]), quoted([{ value: form, count }]),
    quoted([{ value: "NOUN", count }]), "unreviewed", "", "", "",
    quoted([{ sentence_id: `${form}-1`, text: `${form} context`, translation: "訳", collection: "A", document: null, dialect: "Saru", dialect_path: "北海道/南西/沙流", region, uri: null, source_slug: null }]),
  ].join("\t");
}

const TSV = [
  "# Unseeded corpus words",
  "# corpus_tokens: 10",
  HEADER,
  row(1, "eci", "tagger_lemma_suggestion", 7, "北海道"),
  row(2, "usike", "unresolved", 5, "北海道"),
  row(3, "reekoh", "unresolved", 4, "樺太"),
].join("\n") + "\n";

test("parses metadata, quoted JSON fields, and detail records", () => {
  const snapshot = parseUnseededWords(TSV);
  expect(snapshot.metadata.corpus_tokens).toBe("10");
  expect(snapshot.words).toHaveLength(3);
  expect(snapshot.byForm.get("eci")?.canonical_candidates).toEqual([{ value: "eci=", count: 7 }]);
  expect(snapshot.byForm.get("usike")?.contexts[0].translation).toBe("訳");
});

test("filters and paginates summaries while retaining one example", () => {
  const result = selectUnseededWords(parseUnseededWords(TSV), {
    lookupStatus: "unresolved",
    region: "北海道",
    minCount: 5,
    minCollections: 2,
    limit: 10,
  });
  expect(result.total).toBe(1);
  expect(result.words[0].form).toBe("usike");
  expect(result.words[0].example?.sentence_id).toBe("usike-1");
  expect("contexts" in result.words[0]).toBe(false);
});
