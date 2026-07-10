/**
 * Curated search examples — a single source of truth for "things worth trying"
 * across every search surface (KWIC, POS, collocation, structural, analytics,
 * inflection, text). Served at `GET /v1/examples` so the API is self-describing
 * and the UI can render runnable example chips without hard-coding them in HTML.
 *
 * Each example is a self-contained, runnable spec:
 *   - `mode`   which UI tab / endpoint it belongs to
 *   - `label`  short human title (what you'll learn)
 *   - `desc`   one line of linguistic motivation
 *   - `params` the query params to apply (the UI maps these onto its form)
 *   - `path`   a ready-to-call relative API URL (so non-UI consumers/tests can
 *              fire it directly without re-deriving the endpoint)
 *
 * Keep these SMALL and PEDAGOGICAL — they double as smoke tests and as a tour
 * of what the corpus can answer. Ainu glosses are kept in the `desc`.
 */
export type ExampleMode =
  | "kwic" | "pos" | "collocation" | "structural" | "analytics" | "inflection" | "text";

export interface SearchExample {
  mode: ExampleMode;
  label: string;
  desc: string;
  params: Record<string, string>;
  path: string;
}

function qs(params: Record<string, string>): string {
  const u = new URLSearchParams(params);
  return u.toString();
}

/** Build an example, deriving the runnable `path` from mode + params. */
function ex(mode: ExampleMode, base: string, label: string, desc: string, params: Record<string, string>): SearchExample {
  return { mode, label, desc, params, path: `${base}?${qs(params)}` };
}

export const SEARCH_EXAMPLES: SearchExample[] = [
  // ── KWIC concordance ──────────────────────────────────────────────
  ex("kwic", "/v1/kwic", "kor — possession/relative",
     "How the multi-purpose verb kor ‘have’ behaves; sort by the following word.",
     { q: "kor", sort: "r1", ctx: "5", limit: "50" }),
  ex("kwic", "/v1/kwic", "rayke (Saru only)",
     "rayke ‘kill’ restricted to the Saru (沙流) dialect.",
     { q: "rayke", dialect: "沙流", sort: "r1", limit: "50" }),
  ex("kwic", "/v1/kwic", "ramat ≈ rámat (accent-folded)",
     "Accent-insensitive node match: ramat also finds pitch-marked rámat.",
     { q: "ramat", match: "fold", limit: "50" }),
  ex("kwic", "/v1/kwic", "arpa + plural paye",
     "Singular↔plural: one search over arpa ‘go.SG’ also surfaces suppletive paye ‘go.PL’.",
     { q: "arpa", expand: "plural", sort: "l1", limit: "60" }),
  ex("kwic", "/v1/kwic", "ku= (1SG.A clitic)",
     "Personal clitic as its own token — first-person singular transitive subject.",
     { q: "ku=", clitic: "only", sort: "r1", limit: "50" }),
  ex("kwic", "/v1/kwic", "kamuy- (prefix search)",
     "Prefix match: every token starting kamuy- (kamuy, kamuyhu, kamuykar…).",
     { q: "kamuy", match: "prefix", limit: "60" }),
  ex("kwic", "/v1/kwic", "eci across orthographies (regex)",
     "Word regex: /ech?i/ matches modern eci and Batchelor-style echi in one search (anchor with ^ $).",
     { q: "ech?i", match: "regex", limit: "50" }),

  // ── POS / grammatical search ──────────────────────────────────────
  ex("pos", "/v1/pos", "Intransitive verbs taking =an",
     "VERB immediately followed by the 1PL/indef clitic =an — a productive frame.",
     { upos: "VERB", next_surface: "=an", limit: "50" }),
  ex("pos", "/v1/pos", "Nouns before copula ne",
     "NOUN followed by ne — predicate-nominal ‘is a N’ constructions.",
     { upos: "NOUN", next_surface: "ne", limit: "50" }),
  ex("pos", "/v1/pos", "All inflected forms of arpa",
     "Every token whose lemma is arpa, regardless of surface.",
     { lemma: "arpa", limit: "50" }),

  // ── Collocation ───────────────────────────────────────────────────
  ex("collocation", "/v1/collocation", "kamuy collocates (logDice)",
     "Strongest lexical partners of kamuy ‘god/bear’ within ±5 tokens.",
     { q: "kamuy", window: "5", measure: "log_dice", limit: "30" }),
  ex("collocation", "/v1/collocation", "What precedes kor?",
     "Left-span collocates of kor ‘have’ — typical possessors/objects.",
     { q: "kor", span: "left", window: "3", measure: "t_score", limit: "30" }),

  // ── Structural (CQL-lite) ─────────────────────────────────────────
  ex("structural", "/v1/structural", "NOUN + NOUN (compounding)",
     "Two adjacent nouns — candidate compounds / noun incorporation.",
     { pattern: "[upos=NOUN] [upos=NOUN]", limit: "50" }),
  ex("structural", "/v1/structural", "a= __ VERB (1SG.A + verb)",
     "First-person clitic a=, any token, then a verb.",
     { pattern: "[surface=a=] [] [upos=VERB]", limit: "50" }),
  ex("structural", "/v1/structural", "regex word sequence",
     "Adjacent words each matched by a regex: eci/echi followed by an a-initial word.",
     { pattern: "/ech?i/ /^a/", limit: "50" }),
  ex("structural", "/v1/structural", "VERB + wa (sequential)",
     "Verb followed by the conjunction wa ‘and/then’.",
     { pattern: "[upos=VERB] wa", limit: "50" }),

  // ── Analytics ─────────────────────────────────────────────────────
  ex("analytics", "/v1/analytics", "kamuy distribution",
     "Frequency of kamuy by dialect, author, collection, and its POS spread.",
     { q: "kamuy", match: "fold", top: "10" }),

  // ── Inflection lookup ─────────────────────────────────────────────
  ex("inflection", "/v1/inflections", "Forms of arpa",
     "Inflectional relatives of arpa (suppletive plural paye, …).",
     { word: "arpa" }),
  ex("inflection", "/v1/inflections", "Possessed forms of sapa",
     "Possessed (所属形) realizations of sapa ‘head’ — short/long.",
     { word: "sapa" }),

  // ── Plain text ────────────────────────────────────────────────────
  ex("text", "/v1/search", "Japanese gloss: 神",
     "Sentences whose Japanese translation contains 神 ‘god’.",
     { q: "神", lang: "jpn", limit: "20" }),
];

/** Optionally filter by mode (the UI asks for just the active tab's examples). */
export function examplesFor(mode?: string | null): SearchExample[] {
  if (!mode) return SEARCH_EXAMPLES;
  return SEARCH_EXAMPLES.filter((e) => e.mode === mode);
}
