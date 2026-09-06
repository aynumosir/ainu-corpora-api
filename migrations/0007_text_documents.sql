-- Phase 9: reading order for continuous texts.
--
-- ADDITIVE and reversible (DROP TABLE text_documents; DROP INDEX
-- idx_sentences_source_row). One row per document of a registered source:
-- the sentence-id prefix before '#' (aa-asai/001, bible/1co/001) names the
-- document, and its sentences occupy one contiguous row_order range, so a
-- reader page is a single indexed range scan. Rebuilt from `sentences` by
-- scripts/load_tokens.mjs after every load (see src/text.ts for the SQL).

CREATE TABLE IF NOT EXISTS text_documents (
  source_slug TEXT NOT NULL,        -- db.aynu.org source-record slug
  key TEXT NOT NULL,                -- sentence-id prefix, e.g. aa-asai/001
  ord INTEGER NOT NULL,             -- 0-based position among the source's documents
  title TEXT,                       -- sentences.document
  row_start INTEGER NOT NULL,       -- sentences.row_order of the first sentence
  row_end INTEGER NOT NULL,         -- sentences.row_order of the last sentence (inclusive)
  sentences INTEGER NOT NULL,
  translated INTEGER NOT NULL,      -- sentences carrying a non-empty translation
  text_layer TEXT,                  -- modern-orthography sidecar id when every sentence has one
  text_layer_status TEXT,           -- provisional | reviewed, when text_layer is set
  uri TEXT,                         -- where the document was taken from
  PRIMARY KEY (source_slug, key)
);
CREATE INDEX IF NOT EXISTS idx_text_documents_source_ord ON text_documents (source_slug, ord);

-- The reader's range scan: WHERE source_slug = ? AND row_order BETWEEN ? AND ?
CREATE INDEX IF NOT EXISTS idx_sentences_source_row ON sentences (source_slug, row_order);
