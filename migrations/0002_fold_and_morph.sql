-- Phase 4: accent-insensitive search + morphology (inflection) layer.
--
-- ADDITIVE and reversible. Two independent pieces:
--
-- 1. `corpus_tokens.surface_fold` — the pitch/length-folded search key
--    (see src/normalize.ts foldToken). Lets KWIC match "nea" == "néa" and
--    "ramat" == "rámat" without losing the original surface for display.
--    Backfilled by scripts/load_tokens.mjs (and recomputable in pure SQL is
--    NOT possible — NFD/diacritic folding is done in JS at load time).
--
-- 2. `morph_forms` — a small inflection table (singular↔plural verbs,
--    possessed-noun forms) lifted from ../ainu-morpheme-database forms.json.
--    Powers "search singular AND its plural together" and the inflection
--    chooser in the UI. Keyed by the FOLDED surface so it joins the token key.

ALTER TABLE corpus_tokens ADD COLUMN surface_fold TEXT;
CREATE INDEX IF NOT EXISTS idx_tokens_surface_fold ON corpus_tokens (surface_fold);
CREATE INDEX IF NOT EXISTS idx_tokens_fold_sent_idx ON corpus_tokens (surface_fold, sentence_id, idx);

-- One row per (lemma, surface) inflected form. `relation` is the morphological
-- relation (plural / possessed / derived). `number_locus` (subject/object) and
-- the raw feature bundle ride along for display/filtering. surface_fold is the
-- join key into corpus_tokens.
CREATE TABLE IF NOT EXISTS morph_forms (
  lemma         TEXT NOT NULL,   -- citation/base form (e.g. "arpa")
  lemma_fold    TEXT NOT NULL,   -- foldToken(lemma)
  surface       TEXT NOT NULL,   -- inflected surface (e.g. "paye")
  surface_fold  TEXT NOT NULL,   -- foldToken(surface) — joins corpus_tokens
  relation      TEXT NOT NULL,   -- plural | possessed | derived
  number_locus  TEXT,            -- subject | object | NULL
  form_length   TEXT,            -- short | long | NULL (possessed)
  source        TEXT,            -- attested | rule | exception
  confidence    REAL,
  rule_id       TEXT,
  PRIMARY KEY (lemma_fold, surface_fold, relation)
);
CREATE INDEX IF NOT EXISTS idx_morph_lemma_fold ON morph_forms (lemma_fold);
CREATE INDEX IF NOT EXISTS idx_morph_surface_fold ON morph_forms (surface_fold);
CREATE INDEX IF NOT EXISTS idx_morph_relation ON morph_forms (relation);
