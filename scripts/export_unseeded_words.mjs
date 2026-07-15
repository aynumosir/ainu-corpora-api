#!/usr/bin/env bun
/**
 * Export recurring corpus words that cannot reach an MDB gloss.
 *
 * A token is resolved when its surface, generated-form lemma, lexical
 * equivalence, or context-licensed conditioned form has a gloss. Machine
 * tagger lemmas remain visible as review suggestions.
 *
 *   bun scripts/export_unseeded_words.mjs \
 *     --db=build/corpus.db \
 *     --equivalences=../ainu-morpheme-database/lexeme_db/lemma_equivalences.json \
 *     --out=data/unseeded_words.tsv
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { foldToken } from "../src/normalize.ts";

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
}

function hasTable(db, table) {
  return Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function hasGlossSql(alias) {
  return `coalesce(nullif(trim(${alias}.gloss_en), ''), nullif(trim(${alias}.gloss_jp), '')) IS NOT NULL`;
}

function addVote(map, value) {
  if (!value) return;
  map.set(value, (map.get(value) ?? 0) + 1);
}

function rankedVotes(map) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, count }));
}

function canonicalLexicalForm(form, lexicalRules) {
  let value = form;
  for (const rule of lexicalRules) {
    for (const variant of rule.variants ?? []) {
      const foldedVariant = foldToken(String(variant));
      const foldedCanonical = foldToken(String(rule.canonical ?? ""));
      if (!foldedVariant || !foldedCanonical) continue;
      value = rule.match === "substring"
        ? value.replaceAll(foldedVariant, foldedCanonical)
        : value === foldedVariant ? foldedCanonical : value;
    }
  }
  return value;
}

function conditionedIndex(registry) {
  const rules = new Map((registry.conditioned_rules ?? []).map((rule) => [String(rule.id), rule]));
  const bySurface = new Map();
  for (const entry of registry.conditioned ?? []) {
    const rule = rules.get(String(entry.rule ?? ""));
    if (!rule || rule.condition !== "person_prefix") continue;
    const surface = foldToken(String(entry.surface ?? ""));
    const canonical = foldToken(String(entry.canonical ?? ""));
    const prefixes = (rule.prefixes ?? []).map((prefix) => foldToken(String(prefix))).filter(Boolean);
    if (surface && canonical && prefixes.length) bySurface.set(surface, { canonical, prefixes });
  }
  return bySurface;
}

export function loadReviews(path) {
  if (!path || !existsSync(path)) return new Map();
  const payload = JSON.parse(readFileSync(path, "utf8"));
  const reviews = new Map();
  for (const group of payload.groups ?? []) {
    const shared = Object.fromEntries(
      ["disposition", "evidence", "note"].filter((field) => group[field]).map((field) => [field, String(group[field])]),
    );
    for (const form of group.forms ?? []) reviews.set(foldToken(String(form)), { ...shared });
  }
  for (const [form, entry] of Object.entries(payload.entries ?? {})) {
    const key = foldToken(form);
    reviews.set(key, {
      ...(reviews.get(key) ?? {}),
      ...Object.fromEntries(
        ["disposition", "suggested_parse", "evidence", "note"]
          .filter((field) => entry[field])
          .map((field) => [field, String(entry[field])]),
      ),
    });
  }
  return reviews;
}

function conditionedCanonical(form, previous, conditioned) {
  const direct = conditioned.get(form);
  if (direct && direct.prefixes.some((prefix) => previous === `${prefix}=`)) return direct.canonical;

  for (const [surface, entry] of conditioned) {
    for (const prefix of [...entry.prefixes].sort((a, b) => b.length - a.length || a.localeCompare(b))) {
      if (form === `${prefix}${surface}` || form === `${prefix}=${surface}`) return entry.canonical;
    }
  }
  return null;
}

function quoteTsv(value) {
  const text = String(value ?? "");
  return /[\t\n\r"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function sorted(values) {
  return [...values].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function excerpt(text, start, end, limit = 320) {
  const value = String(text ?? "");
  if (value.length <= limit) return value.replaceAll(/\s+/g, " ").trim();
  const nodeStart = Math.max(0, Number(start) || 0);
  const nodeEnd = Math.max(nodeStart, Number(end) || nodeStart);
  const left = Math.max(0, nodeStart - Math.floor((limit - (nodeEnd - nodeStart)) / 2));
  const right = Math.min(value.length, left + limit);
  const slice = value.slice(left, right).replaceAll(/\s+/g, " ").trim();
  return `${left > 0 ? "…" : ""}${slice}${right < value.length ? "…" : ""}`;
}

function shortened(text, limit = 500) {
  const value = String(text ?? "").replaceAll(/\s+/g, " ").trim();
  return value.length <= limit ? value : value.slice(0, limit).trimEnd() + "…";
}

function sourceContext(row) {
  return {
    sentence_id: row.sentence_id,
    text: excerpt(row.text, row.char_start, row.char_end),
    translation: row.translation ? shortened(row.translation) : null,
    collection: row.collection || null,
    document: row.document || null,
    dialect: row.dialect || null,
    dialect_path: row.dialect_path || null,
    region: row.region || null,
    uri: row.uri || null,
    source_slug: row.source_slug || null,
  };
}

export function collectUnseededWords({
  db,
  registry,
  minCount = 5,
  minCollections = 2,
  limit = 5000,
  maxContexts = 3,
  region = null,
  reviews = new Map(),
}) {
  if (!hasTable(db, "corpus_tokens") || !hasTable(db, "sentences") || !hasTable(db, "morph_gloss")) {
    throw new Error("corpus_tokens, sentences, and morph_gloss are required");
  }

  const knownGlosses = new Set(
    db.query(`SELECT key_fold FROM morph_gloss mg WHERE ${hasGlossSql("mg")}`).all().map((row) => row.key_fold),
  );
  const lexicalRules = registry.lexical ?? [];
  const conditioned = conditionedIndex(registry);
  const morphFilter = hasTable(db, "morph_forms")
    ? `AND NOT EXISTS (
         SELECT 1 FROM morph_forms mf
         JOIN morph_gloss base ON base.key_fold = mf.lemma_fold
         WHERE mf.surface_fold = t.surface_fold AND ${hasGlossSql("base")}
       )`
    : "";
  const regionFilter = region ? "AND s.region = ?" : "";
  const rows = db.query(`
    SELECT t.sentence_id, t.idx, t.surface, t.surface_norm, t.surface_fold,
           t.char_start, t.char_end,
           t.lemma, t.upos,
           previous.surface_fold AS previous_fold,
           s.text, s.translation, s.collection, s.document, s.dialect,
           s.dialect_path, s.region, s.uri, s.source_slug, s.row_order
    FROM corpus_tokens t
    JOIN sentences s ON s.id = t.sentence_id
    LEFT JOIN corpus_tokens previous
      ON previous.sentence_id = t.sentence_id AND previous.idx = t.idx - 1
    WHERE t.script = 'latn'
      AND t.is_clitic = 0
      AND t.surface_fold GLOB '*[a-z]*'
      AND t.surface_fold NOT GLOB '*[0-9]*'
      AND instr(t.surface_fold, '.') = 0
      AND coalesce(t.upos, '') <> 'PUNCT'
      AND NOT EXISTS (
        SELECT 1 FROM morph_gloss direct
        WHERE direct.key_fold = t.surface_fold AND ${hasGlossSql("direct")}
      )
      ${morphFilter}
      ${regionFilter}
    ORDER BY s.row_order, t.idx
  `).all(...(region ? [region] : []));

  const unresolved = new Map();
  const resolutions = { lexical_equivalence: 0, conditioned_form: 0, tagger_lemma_suggestion: 0 };
  for (const row of rows) {
    const form = String(row.surface_fold);
    const canonical = canonicalLexicalForm(form, lexicalRules);
    if (canonical !== form && knownGlosses.has(canonical)) {
      resolutions.lexical_equivalence++;
      continue;
    }

    const conditionedLemma = conditionedCanonical(form, String(row.previous_fold ?? ""), conditioned);
    if (conditionedLemma && knownGlosses.has(conditionedLemma)) {
      resolutions.conditioned_form++;
      continue;
    }

    const taggerLemma = foldToken(String(row.lemma ?? ""));
    const suggestedCanonical = taggerLemma && knownGlosses.has(taggerLemma) ? taggerLemma : "";
    if (suggestedCanonical) resolutions.tagger_lemma_suggestion++;

    let record = unresolved.get(form);
    if (!record) {
      record = {
        form,
        occurrences: 0,
        surfaces: new Set(),
        collections: new Set(),
        dialects: new Set(),
        dialect_paths: new Set(),
        regions: new Set(),
        lemmaVotes: new Map(),
        canonicalVotes: new Map(),
        uposVotes: new Map(),
        contexts: [],
        contextIds: new Set(),
        contextCollections: new Set(),
      };
      unresolved.set(form, record);
    }
    record.occurrences++;
    record.surfaces.add(String(row.surface_norm || row.surface));
    if (row.collection) record.collections.add(String(row.collection));
    if (row.dialect) record.dialects.add(String(row.dialect));
    if (row.dialect_path) record.dialect_paths.add(String(row.dialect_path));
    if (row.region) record.regions.add(String(row.region));
    addVote(record.lemmaVotes, taggerLemma);
    addVote(record.canonicalVotes, suggestedCanonical);
    addVote(record.uposVotes, String(row.upos ?? ""));
    const contextCollection = String(row.collection || row.sentence_id);
    if (record.contexts.length < maxContexts && !record.contextIds.has(row.sentence_id)
        && !record.contextCollections.has(contextCollection)) {
      record.contextIds.add(row.sentence_id);
      record.contextCollections.add(contextCollection);
      record.contexts.push(sourceContext(row));
    }
  }

  const words = [...unresolved.values()]
    .filter((row) => row.occurrences >= minCount && row.collections.size >= minCollections)
    .sort((a, b) => b.occurrences - a.occurrences || b.collections.size - a.collections.size || a.form.localeCompare(b.form))
    .slice(0, limit)
    .map((row, index) => ({
      rank: index + 1,
      form: row.form,
      lookup_status: row.canonicalVotes.size ? "tagger_lemma_suggestion" : "unresolved",
      canonical_candidates: rankedVotes(row.canonicalVotes),
      occurrences: row.occurrences,
      collection_count: row.collections.size,
      dialect_count: row.dialects.size,
      region_count: row.regions.size,
      surfaces: sorted(row.surfaces),
      collections: sorted(row.collections),
      dialects: sorted(row.dialects),
      dialect_paths: sorted(row.dialect_paths),
      regions: sorted(row.regions),
      tagger_lemmas: rankedVotes(row.lemmaVotes),
      tagger_pos: rankedVotes(row.uposVotes),
      review_disposition: reviews.get(row.form)?.disposition ?? "unreviewed",
      suggested_parse: reviews.get(row.form)?.suggested_parse ?? "",
      evidence: reviews.get(row.form)?.evidence ?? "",
      note: reviews.get(row.form)?.note ?? "",
      contexts: row.contexts,
    }));

  return { words, scanned_occurrences: rows.length, resolutions };
}

export function writeUnseededWords(path, result, metadata = {}) {
  const fields = [
    "rank", "form", "lookup_status", "canonical_candidates",
    "occurrences", "collection_count", "dialect_count", "region_count",
    "surfaces", "collections", "dialects", "dialect_paths", "regions",
    "tagger_lemmas", "tagger_pos", "review_disposition", "suggested_parse",
    "evidence", "note", "contexts",
  ];
  const lines = [
    "# Unseeded corpus words",
    "# Each row is attested in the corpus and cannot reach an MDB gloss through the registered resolution paths.",
    `# corpus_sentences: ${metadata.corpus_sentences ?? "unknown"}`,
    `# corpus_tokens: ${metadata.corpus_tokens ?? "unknown"}`,
    `# equivalences_sha256: ${metadata.equivalences_sha256 ?? "unknown"}`,
    `# reviews_sha256: ${metadata.reviews_sha256 ?? "none"}`,
    `# scanned_unresolved_occurrences: ${result.scanned_occurrences}`,
    `# resolved_lexical_equivalence: ${result.resolutions.lexical_equivalence}`,
    `# resolved_conditioned_form: ${result.resolutions.conditioned_form}`,
    `# tagger_lemma_suggestion_occurrences: ${result.resolutions.tagger_lemma_suggestion}`,
    fields.join("\t"),
  ];
  for (const word of result.words) {
    lines.push(fields.map((field) => quoteTsv(
      Array.isArray(word[field]) || typeof word[field] === "object"
        ? JSON.stringify(word[field])
        : word[field],
    )).join("\t"));
  }
  writeFileSync(path, lines.join("\n") + "\n");
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function main() {
  const dbPath = arg("db", new URL("../build/corpus.db", import.meta.url).pathname);
  const equivalencesPath = arg(
    "equivalences",
    new URL("../../ainu-morpheme-database/lexeme_db/lemma_equivalences.json", import.meta.url).pathname,
  );
  const outPath = arg("out", new URL("../data/unseeded_words.tsv", import.meta.url).pathname);
  const reviewsPath = arg(
    "reviews",
    new URL("../../ainu-morpheme-database/morpheme_db/seed/bible_unglossed_reviews.json", import.meta.url).pathname,
  );
  const minCount = positiveInteger(arg("min-count", "5"), 5);
  const minCollections = positiveInteger(arg("min-collections", "2"), 2);
  const limit = positiveInteger(arg("limit", "5000"), 5000);
  const maxContexts = positiveInteger(arg("contexts", "3"), 3);
  const region = arg("region", "") || null;

  const registry = JSON.parse(readFileSync(equivalencesPath, "utf8"));
  const reviews = loadReviews(reviewsPath);
  const db = new Database(dbPath, { readonly: true });
  const result = collectUnseededWords({ db, registry, minCount, minCollections, limit, maxContexts, region, reviews });
  const corpusSentences = db.query("SELECT count(*) count FROM sentences").get().count;
  const corpusTokens = db.query("SELECT count(*) count FROM corpus_tokens").get().count;
  db.close();
  writeUnseededWords(outPath, result, {
    corpus_sentences: corpusSentences,
    corpus_tokens: corpusTokens,
    equivalences_sha256: sha256(equivalencesPath),
    reviews_sha256: existsSync(reviewsPath) ? sha256(reviewsPath) : "none",
  });
  console.log(`unseeded words: ${result.words.length} -> ${outPath}`);
  console.log(`resolved before review: ${JSON.stringify(result.resolutions)}`);
}

if (import.meta.main) main();
