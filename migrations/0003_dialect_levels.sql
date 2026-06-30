-- Phase 5: structured three-level dialect division.
--
-- ADDITIVE and reversible. The source corpus (ainu-corpora data.jsonl) already
-- carries a hierarchical dialect taxonomy in `dialect_lv1/2/3` that the token
-- layer previously discarded (it only copied the free-text `dialect`). This
-- restores it so the UI can offer a Hokkaido/Sakhalin tab (lv1) plus a
-- specific-dialect sub-select (lv2/lv3), per the three-level division:
--
--   lv1 = 北海道 (Hokkaido) | 樺太 (Sakhalin)            ← never multi-valued
--   lv2 = 北海道/南西, 北海道/北東, 樺太/西海岸, …       ← region
--   lv3 = 北海道/南西/沙流, …                            ← specific dialect (multi-valued)
--
-- Columns:
--   region        — lv1 only ("北海道" | "樺太" | NULL). Fast tab filter + facet.
--   dialect_path  — the single most-specific path (deepest available lv) for
--                   display, e.g. "北海道/南西/沙流".
--   dialect_paths — ALL most-specific paths a sentence belongs to, each wrapped
--                   in U+001F delimiters: "\x1f北海道/南西/沙流\x1f…\x1f". This
--                   makes a hierarchical membership test a single substring scan:
--                   "belongs at-or-below prefix P"  ==  instr(dialect_paths, x'1f'||P) > 0
--                   Because every stored path starts right after a \x1f and the
--                   levels are slash-delimited full segments, a prefix like
--                   "北海道/南西" matches "北海道/南西" and "北海道/南西/沙流"
--                   but never "樺太…" — and segment-internal false matches are
--                   impossible (the prefix is anchored to a path start).

ALTER TABLE sentences ADD COLUMN region TEXT;
ALTER TABLE sentences ADD COLUMN dialect_path TEXT;
ALTER TABLE sentences ADD COLUMN dialect_paths TEXT;

CREATE INDEX IF NOT EXISTS idx_sentences_region ON sentences (region);
CREATE INDEX IF NOT EXISTS idx_sentences_dialect_path ON sentences (dialect_path);
