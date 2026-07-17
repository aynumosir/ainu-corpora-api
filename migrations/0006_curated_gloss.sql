-- Phase 8: curated gloss layers (ainu-corpora-annotations).
--
-- Sentence-level, token-aligned HUMAN glosses imported from the
-- ainu-corpora-annotations repo (layers/<name>/). These are analyses that
-- ainu-corpora policy keeps out of the corpus itself (it only publishes
-- fields consumed by Tunci/Kampisos), so the API is their query surface.
--
-- Distinct from morph_gloss (0004): that is a per-token GENERATED display
-- lookup keyed by folded surface, context-free by construction. A curated
-- layer is contextual, covers specific sentences, carries provenance
-- (author, origin URL, source revision) and an explicit credibility label
-- so frontends can present the two side by side without conflating them.
--
-- Purely ADDITIVE and reversible: DROP TABLE curated_gloss, gloss_layers.

CREATE TABLE IF NOT EXISTS gloss_layers (
  id                TEXT PRIMARY KEY, -- layer slug, e.g. 'hokudai-respect-gloss'
  credibility       TEXT NOT NULL,    -- 'curated' | 'generated'
  language          TEXT NOT NULL,    -- gloss language ('ja', 'en', …)
  status            TEXT,             -- layer status ('provisional', …)
  author            TEXT,             -- who produced the gloss
  origin_url        TEXT,             -- where it was published
  origin_title      TEXT,             -- title of the origin document
  description       TEXT,
  source_repository TEXT,             -- annotations repo the layer came from
  source_revision   TEXT,             -- corpus revision the layer is pinned to
  retrieved_at      TEXT              -- when the origin was captured
);

-- One row per PART of a sentence. Most sentences have exactly one part; long
-- sentences glossed in chunks keep one row per chunk (part_idx preserves
-- order). `pairs` is the precomputed token alignment: JSON [[ain, gloss], …]
-- when the part's ain and gloss lines are 1:1 by whitespace token (aligned=1),
-- NULL otherwise (frontends then render the two lines stacked). Alignment is
-- computed at build time (scripts/build_curated_gloss.py) because curated
-- glosses legitimately fuse or group tokens (multiword proper nouns, fused
-- readings) — a positional zip in SQL or UI code would silently misalign.
CREATE TABLE IF NOT EXISTS curated_gloss (
  layer_id    TEXT NOT NULL,          -- gloss_layers.id
  sentence_id TEXT NOT NULL,          -- sentences.id (e.g. hokudai-respect/full#7)
  part_idx    INTEGER NOT NULL,       -- 0-based part order within the sentence
  ain         TEXT NOT NULL,          -- romanization the gloss was aligned to
  gloss       TEXT NOT NULL,          -- token-aligned gloss line
  interp      TEXT,                   -- free reading of the part
  aligned     INTEGER NOT NULL DEFAULT 0, -- 1 when pairs is a faithful 1:1 zip
  pairs       TEXT,                   -- JSON [[ainTok, glossTok], …] or NULL
  notes       TEXT,                   -- JSON notes array from the layer, or NULL
  divergence  TEXT,                   -- JSON divergence records vs corpus ain, or NULL
  PRIMARY KEY (layer_id, sentence_id, part_idx)
);

CREATE INDEX IF NOT EXISTS idx_curated_gloss_sentence ON curated_gloss (sentence_id);
