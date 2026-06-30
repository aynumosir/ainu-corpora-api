# ainu-corpora-api

Standalone corpus API for [`ainu-corpora`](../ainu-corpora) — search, (later) concordance/KWIC and POS-search — as a Cloudflare Worker at **`corpus.aynu.org`**, backed by Turso/libSQL.

It is the single corpus query surface for the whole ecosystem:

- **`ainu-mcp`** calls it through a `CORPUS` service binding (Worker-to-Worker, no public hop) — the MCP no longer holds corpus SQL.
- **kampisos / frontends** call the public `/v1` HTTPS API (CORS-enabled).

## Why this exists

Corpus search used to live inside `ainu-mcp`'s `db.ts`. It was extracted so the
MCP stays a thin *connector* (mirroring the existing `MDB`/`SOURCES` bindings),
and so KWIC + POS-search — which need a token-level layer — have a home that
every frontend can share. Plan & review notes: see `docs/PLAN.md`.

## Response envelope

Every response is:

```jsonc
{ "api_version": "1", "data": <payload> }                      // success
{ "api_version": "1", "error": { "code": "...", "message": "..." } }  // failure
```

Routes are versioned under `/v1`. Breaking changes bump to `/v2`; `api_version`
also travels in the body so non-URL consumers can assert it.

## Endpoints (Phase 0 — behaviour-identical extraction)

| Method · Route | Params | Returns |
|---|---|---|
| `GET /health` | — | `{ ok, service }` |
| `GET /v1/search` | `q` (required), `lang=ain\|jpn\|any` (def `any`), `dialect`, `author`, `limit` (def 20) | `CorpusRow[]` — `{id,text,translation,dialect,author,collection,document,uri}` |
| `GET /v1/stats` | — | `{ sentences, top_dialects }` (precomputed) |
| `GET /v1/freq/word` | `token` (**already normalized**) | `{ token, found, count, is_stopword, rank }` |
| `GET /v1/freq/list` | `limit` (def 100), `offset` (def 0), `includeStopwords` (def false), `minCount` (def 1) | `{ token, count, is_stopword }[]` |
| `GET /v1/stopwords` | — | `string[]` |
| `GET /v1/stopword` | `token` (**already normalized**) | `{ token, is_stopword }` |
| `GET /v1/candidates` | `minCount` (def 1) | raw vocab-gap `{ token, count, attested_in, sample_text, sample_translation }[]` |

### Normalization contract
`freq`/`stopword` endpoints take an **already gaps-normalized** token. The MCP
performs that normalization in its thin proxy tool (as it did before the split),
so this API stays a 1:1 of the lifted query helpers. Frontends that need
normalization should normalize client-side or via the MCP.

### Glossary-gap note
`/v1/candidates` is the **raw corpus side only**. The old MCP
`glossary_missing_high_frequency` tool subtracted live Google-Sheets glossary
membership; that subtraction **stays in the MCP** (the corpus API holds no Sheets
credentials by design).

## Token layer — KWIC + POS (Phases 1–3)

Backed by `sentences` + `corpus_tokens` (migrations/0001_tokens.sql): 196,184
sentences → 1,679,732 tokens, tokenized with the ainu-morpheme-tagger spaCy
`ain` tokenizer (so clitics `ku=`/`a=`/`=an` are their own tokens) with char
offsets. 1.26M tokens are POS-tagged (`combined_enriched/model-best`, UD UPOS),
**Latin-script only** (the model is Roman-trained); non-Latin rows keep
surface/offset but NULL POS. POS is **machine-tagged, not gold** (`model_version`
recorded per token).

| Method · Route | Params | Returns |
|---|---|---|
| `GET /v1/concordance` | `q` (required), `window` (40), `limit` (50), `sort=none\|left\|right`, `match=exact\|prefix`, `dialect`, `author` | KWIC `{sentence_id,left,node,right,translation,dialect,author,uri}[]` |
| `GET /v1/pos` | at least one of `upos`,`lemma`,`surface`,`next_upos`,`next_surface`; plus `window`,`limit`,`dialect`,`author` | KWIC lines + `{upos,lemma}`. Adjacency via `next_*` (self-join on `idx+1`) — e.g. `?upos=VERB&next_surface==an` |

### Advanced token layer (Phase 4)

Adds an accent-folded search key (`surface_fold`) and a morphology table
(`morph_forms`, from [`ainu-morpheme-database`](../ainu-morpheme-database)) — see
`migrations/0002_fold_and_morph.sql` and `src/normalize.ts`.

| Method · Route | Params | Returns |
|---|---|---|
| `GET /v1/kwic` | `q` (req), `ctx` (6), `limit` (50), `match=fold\|exact\|prefix` (def `fold`), `sort=none\|l1..l3\|r1..r3\|node\|dialect\|author`, `expand=none\|plural\|all`, `upos`, `clitic=any\|only\|exclude`, `dialect`, `author` | Annotated KWIC: left/node/right **token arrays** (`{i,s,n,p,l,x,f,cl}`) + `*_text`. Clickable words, per-token POS/gloss, accent-insensitive, singular↔plural. |
| `GET /v1/collocation` | `q` (req), `window` (5, ≤10), `span=both\|left\|right`, `measure=log_dice\|t_score\|mi`, `minCount` (3), `limit` (50), `dialect`, `author` | `{node,node_freq,corpus_tokens,collocates[]}` with logDice / t-score / MI |
| `GET /v1/structural` | `pattern` (req), `limit` (50), `dialect`, `author` | CQL-lite sequence search (`[upos=NOUN] [upos=NOUN]`, `[surface=ku.*]`, `[]` wildcard). Adjacent self-joins, ≤6 positions. |
| `GET /v1/analytics` | `q` (req), `match` (def `fold`), `top` (10) | `{node,total,dialects[],authors[],collections[],upos[]}` distribution |
| `GET /v1/inflections` | `word` (req) | `{query,fold,forms[]}` — singular↔plural & possessed forms |
| `GET /v1/examples` | `mode` (optional) | Curated runnable examples `{mode,label,desc,params,path}[]` |

**Normalization / folding.** `match=fold` (the KWIC default) is **accent-
insensitive**: pitch acute (`á`) and length circumflex/macron (`â`/`ā`) are
folded, so `nea` finds `néa` and `ramat` finds `rámat`. `surface` and
`surface_norm` keep the original for display. See `src/normalize.ts`.

Rebuild the token layer:
```sh
# 1. tokenize (light, no torch):
PYTHONPATH=../ainu-morpheme-tagger uv run --python 3.12 --with "spacy>=3.8.4" --with "numpy<2" --with click --no-project \
  scripts/build_tokens.py --data ../ainu-corpora/data.jsonl --out build
# 2. POS-tag (CNN, CPU) — run from the tagger repo so lookups/ resolve:
#    (cd ../ainu-morpheme-tagger && PYTHONPATH=. .venv/bin/python ../ainu-corpora-api/scripts/tag_pos.py \
#       --data ../ainu-corpora/data.jsonl --model training/combined_enriched/model-best \
#       --out ../ainu-corpora-api/build --procs 6)
# 3. load (local dry-run, then Turso):
bun scripts/load_tokens.mjs --tokens=../build/tokens_pos.jsonl          # local build/corpus.db + validation
TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… bun scripts/load_tokens.mjs --tokens=../build/tokens_pos.jsonl --turso
```

Phase 4 adds two more inputs, both folded into the same loader:

```sh
# 4. morphology (inflection) table from the sibling morpheme DB:
bun scripts/build_morph.mjs        # → build/morph_forms.jsonl (singular↔plural, possessed)
# load_tokens.mjs then:
#   - backfills corpus_tokens.surface_fold (accent-folded key) at load time, and
#   - loads build/morph_forms.jsonl into morph_forms (if present).
# migrations/0002_fold_and_morph.sql is applied automatically by the loader.
```

## Develop

```sh
bun install
bun run typecheck
bun test
# secrets for a real run:
wrangler secret put DATABASE_URL        # libsql://…turso.io  (Phase 0: the existing ainu-mcp DB)
wrangler secret put DATABASE_AUTH_TOKEN
bun run dev
```

## Deploy

`bun run deploy` (creates the `corpus.aynu.org` custom domain on first deploy).
Cutover is staged: deploy → golden-parity shadow-compare against the MCP's
direct-DB output → flip the MCP to the `CORPUS` binding behind a flag → keep a
rollback path.
