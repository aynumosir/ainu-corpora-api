-- Phase 6: morpheme-database POS/gloss display layer.
--
-- Generated from ../ainu-morpheme-database/morpheme_db/output/morpheme_database.json.
-- This is a SMALL lookup table keyed by the same folded token key as
-- corpus_tokens.surface_fold. It is intentionally a display/annotation layer:
-- it does not replace the machine tagger's raw upos/xpos/lemma columns.
--
-- Examples:
--   ku=, a=, =an  -> pos_display=PERS, gloss_en=1SG.(A)= / 4.A= / =4.S
--   p, pe         -> pos_display=PART, gloss_en=NMLZ
--   no            -> pos_display=PART, gloss_en=ADVZ
--   kor           -> pos_display=NULL, gloss_en=have
--
-- `pos_display` is NULL for content words so the API keeps the tagger UPOS
-- (NOUN/VERB/etc.) and only adds a short gloss line.

CREATE TABLE IF NOT EXISTS morph_gloss (
  key_fold      TEXT PRIMARY KEY, -- join key == corpus_tokens.surface_fold
  key           TEXT NOT NULL,    -- representative surface/lemma key
  lemma         TEXT,
  category      TEXT,             -- morpheme DB category (pers, vt, vi, n, sfx, ...)
  morph_type    TEXT,             -- root | clitic | suffix | prefix
  pos_display   TEXT,             -- PERS/PART/... override, or NULL to keep token upos
  gloss_en      TEXT,             -- short display gloss (first DB gloss, normalized)
  gloss_jp      TEXT,
  source_id     TEXT,             -- morpheme DB id that won for this key
  priority      INTEGER NOT NULL DEFAULT 0,
  alternates    TEXT              -- JSON array of homograph readings that lost the
                                  -- display slot: [{"p":POS,"g":gloss,"mc":cat}, …]
);

-- Idempotent add for tables created before `alternates` existed (the loader
-- tolerates the "duplicate column" error on fresh tables that already have it).
ALTER TABLE morph_gloss ADD COLUMN alternates TEXT;

CREATE INDEX IF NOT EXISTS idx_morph_gloss_key_fold ON morph_gloss (key_fold);
CREATE INDEX IF NOT EXISTS idx_morph_gloss_category ON morph_gloss (category);
