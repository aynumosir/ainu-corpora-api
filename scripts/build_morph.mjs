#!/usr/bin/env bun
/**
 * Build build/morph_forms.jsonl from the sibling ainu-morpheme-database.
 *
 *   bun scripts/build_morph.mjs \
 *     [--forms=../ainu-morpheme-database/morpheme_db/output/forms.json] \
 *     [--out=../build/morph_forms.jsonl]
 *
 * The morpheme DB's forms.json is the generative inflection layer (plural verbs,
 * possessed nouns…). We lift the (lemma, surface, relation, …) tuples and fold
 * both lemma and surface to the corpus search key (src/normalize foldToken) so
 * the corpus API can answer "show this word AND its plural together" and offer
 * an inflection chooser — without the corpus repo depending on the morpheme repo
 * at runtime. Self-forms (surface == lemma) are dropped (no extra search value).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { foldToken } from "../src/normalize.ts";

const formsArg = process.argv.find((a) => a.startsWith("--forms="));
const outArg = process.argv.find((a) => a.startsWith("--out="));
const FORMS = new URL(
  formsArg ? formsArg.slice("--forms=".length)
    : "../../ainu-morpheme-database/morpheme_db/output/forms.json",
  import.meta.url,
);
const OUT = new URL(outArg ? outArg.slice("--out=".length) : "../build/morph_forms.jsonl", import.meta.url);

const forms = JSON.parse(readFileSync(FORMS, "utf8"));
const seen = new Set();
const out = [];
for (const f of forms) {
  const lemma = f.lemma_id;
  const surface = f.surface;
  if (!lemma || !surface) continue;
  const fb = f.feature_bundle ?? {};
  const relation = fb.relation ?? "derived";
  const lemma_fold = foldToken(lemma);
  const surface_fold = foldToken(surface);
  if (!lemma_fold || !surface_fold) continue;
  if (lemma_fold === surface_fold) continue; // self-form: nothing to link
  const key = `${lemma_fold}\u0000${surface_fold}\u0000${relation}`;
  if (seen.has(key)) continue;
  seen.add(key);
  out.push({
    lemma,
    lemma_fold,
    surface,
    surface_fold,
    relation,
    number_locus: fb.number_locus ?? null,
    form_length: (fb.extras && fb.extras.form_length) ?? null,
    source: f.source ?? null,
    confidence: typeof f.confidence === "number" ? f.confidence : null,
    rule_id: f.rule_id ?? null,
  });
}
writeFileSync(OUT, out.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`morph_forms: ${out.length} rows -> ${OUT.pathname}`);
const byRel = {};
for (const r of out) byRel[r.relation] = (byRel[r.relation] ?? 0) + 1;
console.log("  by relation:", byRel);
