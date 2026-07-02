# Consuming `corpus.aynu.org` — integration guide

For **kampisos** (and any other frontend) to add KWIC + POS-search by consuming
the corpus API directly. Full machine-readable spec: [`openapi.yaml`](../openapi.yaml).

## Ground rules
- Base URL `https://corpus.aynu.org`, GET only, CORS open.
- Every response: `{ "api_version": "1", "data": … }` or `{ "api_version": "1", "error": { "code", "message" } }`. Check `error` first.
- `/v1` is stable; breaking changes ship as `/v2` (and `api_version` bumps).
- Pagination via `limit` (+ `offset` where listed). No auth.

## The two new capabilities

### KWIC concordance — `/v1/concordance`
```
GET /v1/concordance?q=rayke&window=30&sort=right&match=exact&dialect=沙流
→ data: [{ sentence_id, left, node, right, translation, dialect, author, uri }]
```
- `q` = node word (normalized: lowercased, edge apostrophes stripped). `match=prefix` for stem search.
- `window` = context chars each side. `sort=left|right` orders by the context beside the node (for aligned reading); `none` = corpus order.
- Render `left` right-aligned, `node` highlighted, `right` left-aligned for a classic concordance grid.

### POS / grammatical search — `/v1/pos`
```
GET /v1/pos?upos=VERB&next_surface==an&limit=20
→ data: [{ sentence_id, left, node, right, upos, lemma, translation, dialect, author, uri }]
```
- Node filters: `upos` (UD: NOUN/VERB/ADP/PART/ADV/DET/AUX/SCONJ/NUM/PRON/INTJ…), `lemma`, `surface`.
- Adjacency: `next_upos` / `next_surface` constrain the immediately following token (self-join on `idx+1`). The `node` field spans node→neighbour.
- Provide ≥1 filter or you get `400 missing_filter`.

**Caveats to surface in the UI:** POS is **machine-tagged** (`combined_enriched/model-best`, UD UPOS), **Latin-script only** — Katakana/Cyrillic tokens are searchable lexically/KWIC but have no POS. Treat tags as high-recall hints, not gold.

## Example uses
| Goal | Query |
|---|---|
| How is `kor` used? | `/v1/concordance?q=kor&window=30&sort=right` |
| Intransitive verbs taking `=an` | `/v1/pos?upos=VERB&next_surface==an` |
| Nouns before `ne` (copula) | `/v1/pos?upos=NOUN&next_surface=ne` |
| All forms of lemma `arpa` | `/v1/pos?lemma=arpa` |
| `rayke` in Sakhalin only | `/v1/concordance?q=rayke&dialect=樺太` |

## Advanced capabilities (Phase 4)

| Goal | Query |
|---|---|
| Annotated KWIC (clickable, POS/gloss, accent-folded) | `/v1/kwic?q=ramat&sort=r1` |
| Search a verb **and** its plural together | `/v1/kwic?q=arpa&expand=plural` |
| 1SG.A clitic in context | `/v1/kwic?q=ku=&clitic=only` |
| Collocates of `kamuy` (logDice) | `/v1/collocation?q=kamuy&measure=log_dice` |
| Noun–noun compounds | `/v1/structural?pattern=[upos=NOUN] [upos=NOUN]` |
| `a=` + any + VERB | `/v1/structural?pattern=[surface=a=] [] [upos=VERB]` |
| Where does `kamuy` occur? | `/v1/analytics?q=kamuy` |
| Inflected relatives of `arpa` | `/v1/inflections?word=arpa` |
| Discover runnable examples | `/v1/examples?mode=kwic` |

- **Accent folding:** `/v1/kwic` and `/v1/analytics` default to `match=fold`,
  which is pitch/length-insensitive (`nea`≡`néa`, `ramat`≡`rámat`). Use
  `match=exact` to keep diacritics, `match=prefix` for stems.
- **`/v1/kwic` tokens** carry `{i,s,n,p,u,l,x,f,g,mc,cl,node?,alt?}` so a UI can
  show a display POS line (`p`, e.g. morpheme-DB `PERS` for `a=`/`ku=`/`=an`) plus
  a short English gloss line (`g`, e.g. `4.A=`, `NMLZ`, `have`). `u` preserves
  the raw tagger UPOS; `mc` is the morpheme-database category. `alt` (present only
  for homographs) lists the other attested readings that lost the display slot as
  `[{p,g,mc}]`, most-likely first — e.g. `pa` shows NOUN "head" with
  `alt:[{g:"PL",mc:"sfx"},{p:"NOUN",g:"mouth"}]`. Every token remains clickable
  (search-on-click).
- **Structural syntax:** `[upos=…]`, `[surface=…]`, `[lemma=…]`,
  `[surface=ku.*]` (prefix), `[]` (any); bare word→surface, bare ALLCAPS→upos.

## Same data via MCP
The MCP (`mcp.aynu.org`) proxies these as the `corpus_concordance` and
`corpus_pos` tools (it calls this API over a service binding) — so LLM agents
get the same capability without touching HTTP.

## Notes for the maintainer
- Token layer = `sentences` + `corpus_tokens` in the shared Turso DB (will split
  to a dedicated corpus DB later; the `/v1` contract won't change when it does).
- Rebuild steps: see [`../README.md`](../README.md).
