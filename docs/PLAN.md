# ainu-corpora-api — plan & review record

## Goal
Add **POS-search** and **KWIC** to the Ainu corpus by extracting all corpus
query logic out of `ainu-mcp` into a standalone Cloudflare Worker
(`corpus.aynu.org`, Turso/libSQL). MCP becomes a thin connector (mirrors the
existing `MDB`/`SOURCES` service bindings); kampisos and frontends consume `/v1`.

## Architecture
```
ainu-corpora (build) ─► Turso (corpus DB) ◄─ ainu-corpora-api (Worker, corpus.aynu.org)
ainu-morpheme-tagger ─batch─► corpus_tokens     /v1/search /stats /freq /stopwords (Phase 0)
                                                /v1/concordance (Phase 2)  /v1/pos (Phase 3)
                                                        ▲
                         ainu-mcp ──CORPUS: Fetcher─────┘   kampisos / UI ──HTTPS──► /v1
```

## Reviews (2026-06-29)
Reviewed by **gpt-5.5** and **fugu-ultra** (Codex). Both: **proceed with changes.**

Consensus changes folded into this plan:
1. **Pre-tokenize before KWIC.** Query-time JS tokenization drifts from the
   spaCy tokenizer (`ci=` / `=an`) and would misalign KWIC from POS rows. Build
   one canonical `corpus_tokens` table with char offsets first.
2. **Both** a `sentences` table + FTS5 *and* a normalized `corpus_tokens` table.
   POS adjacency ("VERB + `=an`") = token self-joins on `idx+1`, never FTS.
3. **`/v1` contract + golden parity tests**; stage → shadow-compare DB-vs-API →
   feature-flag cutover → rollback path.
4. POS is machine annotation: store `model_version` + `confidence`; tagger is
   Roman-trained, weak on Katakana/Cyrillic → mark script / low-confidence.
5. (fugu) Phase 0 wider than first scoped: corpus helpers are used by
   `corpus.ts`, `research.ts`, `frequency.ts`, `gaps.ts` — repoint all.
6. (fugu) `vocab_candidates` is coupled to live Google Sheets in the gap tool →
   **split**: corpus API serves raw candidates, MCP keeps the Sheets subtraction.
7. (fugu) Token count ≈ **1.14M**, not 2–3M — a tokenized corpus + a working
   Python `Concordancer`/POS-search already exist in `ainu-corpora-process`
   (`utils/search.py`, `tokenize.py`, `pos.py`; `create_tokenized_corpus.ipynb`,
   `search_by_pos.ipynb`). Phase 1 is **port + materialize**, not invent.

## Phases
- **Phase 0a — API repo (DONE).** Worker scaffold; lifted corpus read helpers
  verbatim (`corpusSearch`, `getMeta`, `tokenFrequency`, `frequencyList`,
  `stopwordsList`, `isStopword`, `vocabCandidates`); `/v1` routes + envelope +
  CORS; golden parity tests (14, green); typecheck green.
- **Phase 0b — MCP rewire.** Add `CORPUS` service binding; thin proxy in
  `corpus.ts`/`research.ts`/`frequency.ts`/`gaps.ts` behind a feature flag
  (normalization stays MCP-side); deploy API, shadow-compare, flip flag, keep
  rollback.
- **Phase 1 — tokens.** Materialize `sentences` + `corpus_tokens` (char offsets)
  using the canonical `utils` tokenizer (already powers the Concordancer).
- **Phase 2 — KWIC.** `/v1/concordance` over stored tokens (port `Concordancer`).
- **Phase 3 — POS.** spaCy-tagger enrichment (`model_version`+`confidence`,
  script-aware) → `/v1/pos` incl. adjacency. *Heavy batch run → resource-check
  + confirm before running.*
- **Phase 4 — frontend.** Own UI and/or hand neet the `/v1` contract.

## DB note
Phase 0 points the API at the **existing** ainu-mcp Turso DB (no migration);
a dedicated corpus DB can be split out later.
