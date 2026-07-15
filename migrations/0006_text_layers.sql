-- Phase 8: additive text-layer provenance.
--
-- `sentences.text` is the active text tokenized by the API.  For Bible rows it
-- may contain the modern orthography sidecar; `legacy_text` retains the final
-- reviewed 1897 transcription, `text_layer` identifies the sidecar used, and
-- `text_layer_status` communicates whether it is provisional or reviewed.
-- Non-layered rows keep all three new columns NULL.

ALTER TABLE sentences ADD COLUMN legacy_text TEXT;
ALTER TABLE sentences ADD COLUMN text_layer TEXT;
ALTER TABLE sentences ADD COLUMN text_layer_status TEXT;

CREATE INDEX IF NOT EXISTS idx_sentences_text_layer ON sentences (text_layer);
