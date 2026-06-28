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

## Planned (later phases)

| Route | Phase | Notes |
|---|---|---|
| `GET /v1/concordance` | 2 | KWIC over a materialized `corpus_tokens` table (char offsets), ports the Python `Concordancer` |
| `GET /v1/pos` | 3 | POS-search incl. adjacency (token self-joins on `idx+1`); annotations carry `model_version` + `confidence`; script-aware |

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
