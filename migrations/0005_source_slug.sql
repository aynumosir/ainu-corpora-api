-- Phase 7: db.aynu.org source linkage.
--
-- ADDITIVE and reversible. Each sentence gets the slug of its bibliographic
-- source record on db.aynu.org (e.g. collection アイヌ語音声資料 →
-- ainu-audio-materials → https://db.aynu.org/sources/ainu-audio-materials),
-- so frontends can link a hit to full provenance/licensing metadata.
--
-- The correspondence is intentionally held HERE, not in the ainu-corpora data
-- repo: it lives in data/collection_slugs.json (collection title → slug) and
-- is joined into `sentences` at token-load time by scripts/load_tokens.mjs.
-- NULL when a collection has no registered source record.

ALTER TABLE sentences ADD COLUMN source_slug TEXT;

CREATE INDEX IF NOT EXISTS idx_sentences_source_slug ON sentences (source_slug);
