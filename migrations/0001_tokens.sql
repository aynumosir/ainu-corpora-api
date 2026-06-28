-- Phase 1: token layer for KWIC + POS-search.
--
-- Purely ADDITIVE — does not touch corpus_fts / token_freq / anything the
-- live /v1 endpoints already read. Reversible: DROP TABLE corpus_tokens,
-- sentences.
--
-- `sentences` is an addressable copy of each corpus sentence (id mirrors
-- corpus_fts.id / ainu-corpora data.jsonl id) so token rows can join back to
-- the source text by an indexed PK (FTS5 `id` is UNINDEXED → scans).
CREATE TABLE IF NOT EXISTS sentences (
  id TEXT PRIMARY KEY,
  row_order INTEGER NOT NULL,   -- source-file order (stable ORDER BY)
  text TEXT NOT NULL,
  translation TEXT,
  dialect TEXT,
  author TEXT,
  collection TEXT,
  document TEXT,
  uri TEXT
);
CREATE INDEX IF NOT EXISTS idx_sentences_row_order ON sentences (row_order);

-- One row per token, with char offsets into sentences.text. Tokenized with the
-- ainu-morpheme-tagger tokenizer (spaCy `ain`) — the SAME tokenizer the POS
-- tagger uses, so Phase 3 annotations align with these rows (no drift).
--
-- POS columns (lemma/upos/xpos/feats_json/valency/confidence/model_version) are
-- NULL in Phase 1 and filled in place by the Phase 3 spaCy batch.
CREATE TABLE IF NOT EXISTS corpus_tokens (
  sentence_id TEXT NOT NULL,
  idx INTEGER NOT NULL,         -- 0-based position within the sentence
  surface TEXT NOT NULL,        -- token as it appears in text
  surface_norm TEXT NOT NULL,   -- lowercased, surrounding apostrophes stripped
  char_start INTEGER NOT NULL,  -- offset into sentences.text (token start)
  char_end INTEGER NOT NULL,    -- offset into sentences.text (token end, exclusive)
  script TEXT NOT NULL,         -- latn | kana | cyrl | other (POS reliability hint)
  is_clitic INTEGER NOT NULL DEFAULT 0, -- 1 for personal clitics (ku=, a=, =an, =as)
  lemma TEXT,
  upos TEXT,
  xpos TEXT,
  feats_json TEXT,
  valency TEXT,
  confidence REAL,
  model_version TEXT,
  PRIMARY KEY (sentence_id, idx)
);

-- Lexical search + KWIC node lookup.
CREATE INDEX IF NOT EXISTS idx_tokens_surface_norm ON corpus_tokens (surface_norm);
-- POS-search (filled Phase 3).
CREATE INDEX IF NOT EXISTS idx_tokens_lemma ON corpus_tokens (lemma);
CREATE INDEX IF NOT EXISTS idx_tokens_upos ON corpus_tokens (upos);
-- Adjacency self-joins (e.g. "VERB followed by =an"): match on (key, sentence, idx).
CREATE INDEX IF NOT EXISTS idx_tokens_norm_sent_idx ON corpus_tokens (surface_norm, sentence_id, idx);
CREATE INDEX IF NOT EXISTS idx_tokens_upos_sent_idx ON corpus_tokens (upos, sentence_id, idx);
