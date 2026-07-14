-- Phase 8: additive text-layer provenance.
--
-- `sentences.text` is the active text tokenized by the API.  For Bible rows it
-- may contain the modern orthography sidecar; `legacy_text` retains the final
-- reviewed 1897 transcription and `text_layer` identifies the sidecar used.
-- Non-layered rows keep both new columns NULL.

ALTER TABLE sentences ADD COLUMN legacy_text TEXT;
ALTER TABLE sentences ADD COLUMN text_layer TEXT;

CREATE INDEX IF NOT EXISTS idx_sentences_text_layer ON sentences (text_layer);
