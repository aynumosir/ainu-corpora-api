#!/usr/bin/env bun
/**
 * Build build/morph_gloss.jsonl from the sibling ainu-morpheme-database.
 *
 * This is a compact per-token display lookup for KWIC:
 *   - personal clitics (`category: pers`) display as POS `PERS` and use the
 *     morpheme DB's grammatical gloss (ku= → 1SG.(A)=, =an → =4.S).
 *   - grammatical suffix aliases (-p/-pe/-no) display as PART with NMLZ/ADVZ.
 *   - verbs display the morpheme DB valency tag (VI/VT/VD/VC/V/AUX) rather
 *     than the coarse tagger UPOS, while still preserving raw UPOS in `u`.
 *   - ordinary content words get a short lexical gloss and, where the tagger
 *     left POS blank, a morpheme-DB display POS.
 *   - generated morphology (especially possessed nouns) inherits the base
 *     lexeme's POS/gloss so macihi → maci/mat “wife/woman” is not blank.
 *
 * Output fields match migrations/0004_morph_gloss.sql.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { foldToken, normToken } from "../src/normalize.ts";

const srcArg = process.argv.find((a) => a.startsWith("--src="));
const outArg = process.argv.find((a) => a.startsWith("--out="));
const formsArg = process.argv.find((a) => a.startsWith("--forms="));
const lexArg = process.argv.find((a) => a.startsWith("--lexemes="));
const equivalencesArg = process.argv.find((a) => a.startsWith("--equivalences="));
const SRC = new URL(
  srcArg ? srcArg.slice("--src=".length)
    : "../../ainu-morpheme-database/morpheme_db/output/morpheme_database.json",
  import.meta.url,
);
const OUT = new URL(outArg ? outArg.slice("--out=".length) : "../build/morph_gloss.jsonl", import.meta.url);
const FORMS = new URL(formsArg ? formsArg.slice("--forms=".length) : "../build/morph_forms.jsonl", import.meta.url);
const LEX = new URL(
  lexArg ? lexArg.slice("--lexemes=".length)
    : "../../ainu-morpheme-database/lexeme_db/output/lexeme_bank.json",
  import.meta.url,
);
const EQUIVALENCES = new URL(
  equivalencesArg ? equivalencesArg.slice("--equivalences=".length)
    : "../../ainu-morpheme-database/lexeme_db/lemma_equivalences.json",
  import.meta.url,
);

let lemmaEquivalences = { lexical: [], conditioned: [] };
if (existsSync(EQUIVALENCES)) {
  lemmaEquivalences = JSON.parse(readFileSync(EQUIVALENCES, "utf8"));
}

function canonicalLemma(form) {
  let value = String(form ?? "");
  for (const rule of lemmaEquivalences.lexical ?? []) {
    for (const variant of rule.variants ?? []) {
      value = rule.match === "substring"
        ? value.replaceAll(variant, rule.canonical)
        : (value === variant ? rule.canonical : value);
    }
  }
  return value;
}

function equivalentForms(form) {
  const original = String(form ?? "");
  const canonical = canonicalLemma(original);
  const values = new Set([original, canonical].filter(Boolean));
  for (const rule of lemmaEquivalences.lexical ?? []) {
    for (const variant of rule.variants ?? []) {
      if (rule.match === "substring" && canonical.includes(rule.canonical)) {
        values.add(canonical.replaceAll(rule.canonical, variant));
      } else if (canonical === rule.canonical) {
        values.add(variant);
      }
    }
  }
  return [...values].filter(Boolean);
}

const rows = JSON.parse(readFileSync(SRC, "utf8"));

function first(a) {
  return Array.isArray(a) && a.length ? String(a[0]) : null;
}
function cleanGloss(g) {
  if (!g) return null;
  // Prefer compact Leipzig-ish labels in the UI.
  if (/^ADV\b/i.test(g)) return "ADVZ";
  if (/^NMLZ\b/i.test(g)) return "NMLZ";
  let s = String(g).trim();
  // Preserve compact grammatical glosses (PERS/clitic labels) verbatim:
  // 1SG.(A)=, =4.S, 4.A=, PERF.SG, etc. Lower-case lexical glosses like
  // go.SG / wife.POSS are deliberately NOT caught here and are minimized below.
  if (/^=?[0-9A-Z][0-9A-Z.()=_-]*=?$/.test(s)) return s;

  // Normalize away explanatory material before template matching.
  let t = s
    .replace(/\([^)]*\)/g, "")
    .replace(/…/g, "...")
    .replace(/\.\.\./g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Lexicalized dotted grammatical bits in dictionary glosses make noisy KWIC
  // glosses: wife.POSS → wife, go.SG/go.PL → go, animal's.leg → animal's leg.
  if (/[a-z]/.test(t)) {
    t = t.replace(/\.(?:SG|PL|POSS)\b/g, "").replace(/\.(?=[a-z])/g, " ");
  }

  // Specific dictionary-prose templates → minimal display labels.
  const variant = t.match(/^variant form of ['‘’"]?([^'‘’"]+)['‘’"]?$/i);
  if (variant) return cleanGloss(variant[1]);
  if (/^forms? the ['‘’"]?long form['‘’"]? of the possessive/i.test(t)) return "POSS.LONG";
  if (/^indefinite pronoun someone/i.test(t)) return "someone";
  if (/^suffixed to .*continuing state/i.test(t)) return "state";
  if (/^place\s*\/\s*time where/i.test(t)) return "place/time";
  if (/^as if about to/i.test(t)) return "about to";
  if (/^to suddenly do\s*\/\s*become/i.test(t)) return "suddenly";
  if (/^plural of\b/i.test(t)) return "PL";
  if (/^interrogative particle/i.test(t)) return "Q";
  if (/^suddenly do\s*\/\s*become/i.test(t)) return "suddenly";
  if (/^(?:to\s+)?Ainu name for/i.test(t)) return "Ainu name";
  if (/^(?:to\s+)?get a reputation for/i.test(t)) return "reputation";
  if (/^(?:an?\s+)?object of common fear/i.test(t)) return "fear object";
  if (/^(?:a\s+)?tool one relies on/i.test(t)) return "tool";
  if (/^(?:an?\s+)?elder child of/i.test(t)) return "elder child";
  if (/^(?:to\s+)?throw and stick/i.test(t)) return "throw/stick";
  if (/^(?:to\s+)?throw extremely far/i.test(t)) return "throw far";
  if (/^(?:to be\s+)?rumored that food/i.test(t)) return "food rumor";
  if (/^cave entering/i.test(t)) return "cave";
  if (/^entrance to/i.test(t)) return "entrance";
  if (/^'?s younger brother/i.test(t)) return "younger brother";
  if (/^(?:to be\s+)?skilled with/i.test(t)) return "skilled";
  if (/^(?:a\s+thing\s+to\s+)?be admired or praised/i.test(t)) return "admired";
  if (/^have everything taken away/i.test(t)) return "lose all";
  if (/^soot-screening mat/i.test(t)) return "mat";
  if (/^wooden frame/i.test(t)) return "frame";
  if (/^the outside of a garment/i.test(t)) return "outside";
  if (/^(?:to\s+)?chew at one's clothing/i.test(t)) return "chew clothes";
  if (/^(?:to\s+)?cling on with one's nails/i.test(t)) return "cling";
  if (/^sleep sitting up/i.test(t)) return "sleep sitting";
  if (/^(?:to\s+)?sleep while sitting/i.test(t)) return "sleep sitting";
  if (/^bare floor/i.test(t)) return "bare floor";
  if (/^dirt under the fingernails/i.test(t)) return "fingernail dirt";
  if (/^the late part of the night/i.test(t)) return "late night";
  if (/^thoughout\.the\.night/i.test(t)) return "throughout night";
  if (/^have someone carry/i.test(t)) return "have carry";
  if (/^to have someone carry/i.test(t)) return "have carry";
  if (/^in the middle of the night/i.test(t)) return "midnight";
  if (/^grab and hold briefly/i.test(t)) return "grab briefly";
  if (/^a foreign language/i.test(t)) return "foreign language";
  if (/^to treat(?: .*?)? as (?:a\s+)?stranger/i.test(t)) return "treat stranger";
  if (/^a person who came from elsewhere/i.test(t)) return "stranger";
  if (/^all of us and all/i.test(t)) return "all";
  if (/^dish for serving food/i.test(t)) return "serving dish";
  if (/^a scratch from a nail/i.test(t)) return "scratch";
  if (/^(?:to\s+)?dig in with one's nails/i.test(t)) return "dig nails";
  if (/^(?:to\s+)?have one's fingers spread/i.test(t)) return "spread fingers";

  // Keep display glosses lexical/minimal, not dictionary definitions:
  //   "transitive to kill" → "kill"
  //   "to take charge of ..., to look after ..." → "take charge"
  //   "a person who came from ..." → "person"
  s = t.split(/[;,]/)[0].trim();           // keep first concise sense
  s = s.replace(/^(transitive|intransitive|ditransitive)\s+to\s+/i, "");
  s = s.replace(/^to\s+/i, "");
  s = s.replace(/^be\s+/i, "");
  s = s.replace(/^(?:the|an?)\s+/i, "");
  s = s.replace(/^a\s+thing\s+to\s+/i, "");
  s = s.replace(/^something\s+to\s+be\s+/i, "");
  s = s.replace(/^something\s+to\s+/i, "");
  s = s.replace(/^something\s+spat\s+out$/i, "spit");
  s = s.replace(/^an\s+interesting\s+thing$/i, "interesting");
  s = s.replace(/^thing\s+one\s+cherishes$/i, "cherished");
  s = s.replace(/^possessive\s+form\s+of\b.*$/i, "POSS");
  s = s.replace(/^a\s+person\s+who\s+/i, "person ");
  s = s.replace(/^one\s+who\s+/i, "one ");
  s = s.replace(/\s+of (one's|sb's|sb|sth)\b.*$/i, "");
  s = s.replace(/\s+for (sb|sth)\b.*$/i, "");
  s = s.replace(/\s+with (sb|sth)\b.*$/i, "");
  s = s.replace(/\s+regarding (sb|sth)\b.*$/i, "");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > 18 ? s.slice(0, 17) + "…" : s;
}

function verbalDisplay(m) {
  const cat = String(m.category ?? "").toLowerCase();
  const alts = Array.isArray(m.category_alt) ? m.category_alt.map((x) => String(x).toLowerCase()) : [];
  if (["vi", "vt", "vd", "vc"].includes(cat)) return cat.toUpperCase();
  // Some database rows are conservatively `v` but carry a single clearer
  // valency tag in category_alt; use it for pattern discovery (e.g. ronnu).
  if (cat === "v") {
    const vals = alts.filter((x) => ["vi", "vt", "vd", "vc"].includes(x));
    if (new Set(vals).size === 1) return vals[0].toUpperCase();
    return "V";
  }
  if (cat === "auxv") return "AUX";
  return null;
}

function posDisplay(m, gloss) {
  const cat = String(m.category ?? "").toLowerCase();
  const v = verbalDisplay(m);
  if (v) return v;
  if (cat === "pers") return "PERS";
  // For display, grammaticalizers/nominalizers/adverbializers are more useful
  // as PART than as raw DB categories (sfx/pfx/parti).
  if (cat === "parti") return "PART";
  if (m.morph_type === "suffix" || m.morph_type === "prefix") {
    if (gloss === "NMLZ" || gloss === "ADVZ") return "PART";
  }
  // Use conservative UPOS-like labels from the morpheme DB where it has a
  // lexical category. This fixes blank tagger POS while preserving raw UPOS in
  // the API's `u` field for comparison.
  if (["n", "nl"].includes(cat)) return "NOUN";
  if (cat === "pron") return "PRON";
  if (["adv", "padv", "advp"].includes(cat)) return "ADV";
  if (cat === "adn") return "ADN";
  if (cat === "num") return "NUM";
  if (cat === "intj") return "INTJ";
  if (cat === "sconj") return "SCONJ";
  if (cat === "cconj") return "CCONJ";
  if (cat === "rel") return "REL";
  if (cat === "postp") return "ADP";
  if (cat === "propn") return "PROPN";
  return null;
}
function priority(m, key) {
  let p = 0;
  const gloss = cleanGloss(first(m.glosses_en));
  // Structural bonuses keep grammatical classes ordered above lexical words
  // (pers > NMLZ/ADVZ > clitic > affix). Scaled well above the frequency term so
  // the class ordering is never perturbed by raw frequency.
  if (m.category === "pers") p += 10_000_000;
  if (gloss === "NMLZ" || gloss === "ADVZ") p += 9_000_000;
  if (m.morph_type === "clitic") p += 1_000_000;
  if (m.morph_type === "suffix" || m.morph_type === "prefix") p += 500_000;
  // Well-formedness beats raw frequency: an entry that actually carries a lexical
  // gloss and a displayable POS should win over a more frequent but malformed
  // (glossless / untagged) homograph. These bonuses exceed the max frequency term
  // so they dominate it, but sit below the structural classes above. Without the
  // POS bonus, higher-freq untagged entries stripped the POS off sone/cipo/…; the
  // gloss bonus keeps a glossed reading from losing to a glossless duplicate.
  if (gloss) p += 200_000;
  if (posDisplay(m, gloss)) p += 100_000;
  // Attested frequency is the PRIMARY signal among equally well-formed readings of
  // a homograph. The `verified` flag only breaks ties — it marks a hand-checked
  // gloss, not the dominant reading. Previously verified (+100) outranked the
  // frequency term (freq/1000, ≈0–100), so unattested dictionary duplicates beat
  // common words: nupuri “mountain” (freq 860) lost to a freq-0 “have spiritual
  // power”, iskar lost to a junk entry, hawas/siran to freq-0 accented verbs.
  p += Math.min(Number(m.frequency ?? 0), 99_999);
  if (m.verified) p += 1;
  // Tiebreak only: prefer a clean lemma/surface key over an opaque dotted id
  // (wa over wa.conjunctive). Must NOT overwhelm frequency — a large penalty
  // here flips base selection in entryByFold and drops generated-form glosses.
  if (String(key).includes(".")) p -= 1;
  return Math.round(p);
}
function orthographicVariants(key, m) {
  const cat = String(m.category ?? "").toLowerCase();
  const morphType = String(m.morph_type ?? "").toLowerCase();
  // Do not invent free token variants for bound affixes: this is what caused
  // bare te to incorrectly show CAUS from suffix -e/-te.
  if (morphType !== "root" && morphType !== "word" && morphType !== "form") return [];
  if (!key || key.includes("=") || key.includes("-") || key.includes(" ")) return [];
  const s = foldToken(key);
  if (!s || !/[a-z]/.test(s)) return [];
  const out = new Set();
  const add = (x) => { if (x && x !== s) out.add(x); };

  // Common corpus romanization differences:
  //   c/s ↔ ch/sh (older/Japanese-influenced transcription)
  //   ay/uy/ey ↔ ai/ui/ei (yod written as i)
  //   final -r ↔ -ri in some source orthographies (mosir → moshiri)
  add(s.replace(/c/g, "ch"));
  add(s.replace(/s/g, "sh"));
  add(s.replace(/c/g, "ch").replace(/s/g, "sh"));
  add(s.replace(/ay/g, "ai"));
  add(s.replace(/uy/g, "ui"));
  add(s.replace(/ey/g, "ei"));
  add(s.replace(/ay/g, "ai").replace(/uy/g, "ui").replace(/ey/g, "ei"));
  if (s.endsWith("r")) {
    add(s + "i");
    add(s.replace(/s/g, "sh") + "i");
    add(s.replace(/c/g, "ch") + "i");
  }
  // Some high-frequency particles/nouns are written with final epenthetic -a
  // in the corpus (utar → utara). Limit this to non-verbal roots to avoid
  // over-generating verb forms.
  if (["n", "pron", "parti", "adv", "adn", "rel"].includes(cat) && s.endsWith("r")) add(s + "a");
  return [...out];
}
function keyCandidates(m) {
  const out = new Set();
  const keys = [m.id, m.lemma];
  // IMPORTANT: do NOT blindly expose bare suffix/prefix allomorphs as corpus
  // token gloss keys. Example: the causative suffix -e has allomorph "te", but
  // a corpus token "te" is often an independent word/particle, not CAUS. We add
  // curated bare suffix aliases below (p/pe/no) where the mapping is intended.
  if (m.morph_type === "root" || m.morph_type === "word" || m.morph_type === "form" || m.category === "pers" || m.morph_type === "clitic") {
    keys.push(...(m.allomorphs ?? []));
  }
  for (const k of keys) {
    if (!k) continue;
    const s = String(k);
    for (const equivalent of equivalentForms(s)) {
      out.add(equivalent);
      for (const v of orthographicVariants(equivalent, m)) out.add(v);
    }
    // NOTE: we deliberately do NOT strip the leading dash off bound affixes to
    // expose them as bare token keys. A bare corpus token is a free word, not a
    // bound morpheme, so `-ne` must never claim the `ne` slot — otherwise the
    // glossless/derivational suffix outranks the free root (ne=COP, na=SGST,
    // un=“be located at”, pa=head …) purely on the suffix priority bonus and
    // mis-glosses tens of thousands of tokens. The few intended bare grammatical
    // aliases (p/pe/no NMLZ/ADVZ, utar, irukay) are injected explicitly via
    // forceFrom() below at a curated priority.
  }
  return [...out].filter(Boolean);
}

function recordFromEntry(m, key, pri = priority(m, key)) {
  const gloss = cleanGloss(first(m.glosses_en));
  const glossJp = first(m.glosses_jp);
  const keyFold = foldToken(key);
  if (!keyFold) return null;
  return {
    key_fold: keyFold,
    key: normToken(key),
    lemma: m.lemma ? canonicalLemma(m.lemma) : null,
    category: m.category ?? null,
    morph_type: m.morph_type ?? null,
    pos_display: posDisplay(m, gloss),
    gloss_en: gloss,
    gloss_jp: glossJp,
    source_id: m.id ?? null,
    priority: pri,
  };
}

const best = new Map();
// All glossed candidate readings seen per fold, so homographs (pa = head / PL /
// find, kane = somewhat / metal) can expose the losing readings as `alternates`
// alongside the displayed winner. Fed by the morpheme-DB pass (free readings +
// bound-affix readings) and by the lexeme-bank pass (each dictionary sense); the
// curated forceFrom/forceLiteral overrides are single-reading and skip it.
const candidates = new Map();
function addCandidate(rec) {
  if (!rec || !rec.gloss_en) return;
  const list = candidates.get(rec.key_fold) ?? [];
  list.push(rec);
  candidates.set(rec.key_fold, list);
}
function putBest(rec, { overwrite = false } = {}) {
  if (!rec) return false;
  const prev = best.get(rec.key_fold);
  if (overwrite || !prev || rec.priority > prev.priority) {
    best.set(rec.key_fold, rec);
    return true;
  }
  return false;
}

// Index entries before building aliases/forms. The best direct lexical entry for
// a lemma is what generated forms should inherit from. Unlike display selection,
// base inheritance prefers an entry that actually HAS a lexical gloss: a
// generated possessed/plural form is useless if it inherits from a glossless
// higher-frequency homograph, so a glossed base outranks a glossless one.
const baseScore = (m, k) => priority(m, k) + (first(m.glosses_en) ? 100_000_000 : 0);
const entryByFold = new Map();
for (const m of rows) {
  for (const k of [m.id, m.lemma]) {
    for (const equivalent of equivalentForms(k)) {
      const f = equivalent ? foldToken(equivalent) : "";
      if (!f) continue;
      const prev = entryByFold.get(f);
      if (!prev || baseScore(m, k) > baseScore(prev, prev.id ?? prev.lemma ?? "")) entryByFold.set(f, m);
    }
  }
}

for (const m of rows) {
  const gloss = cleanGloss(first(m.glosses_en));
  const glossJp = first(m.glosses_jp);
  if (!gloss && !glossJp && !posDisplay(m, gloss) && m.category !== "pers") continue;
  for (const key of keyCandidates(m)) {
    const direct = foldToken(key) === foldToken(m.id ?? "") || foldToken(key) === foldToken(m.lemma ?? "") || (m.allomorphs ?? []).some((a) => foldToken(a) === foldToken(key));
    // A directly-attested form must always outrank a generated orthographic
    // variant of some other word: e.g. ora “then” (direct) must beat the
    // epenthetic `or`+a “place” variant, even though `or` is more frequent. The
    // penalty therefore has to exceed the whole frequency/well-formedness range.
    const rec = recordFromEntry(m, key, priority(m, key) + (direct ? 0 : -50_000_000));
    putBest(rec);
    if (direct) addCandidate(rec); // only attested readings, not orthographic guesses
    // A bound affix never WINS a bare token slot (that was the hijack trap), but
    // its reading is a useful ALTERNATE for the homographous bare form — e.g.
    // pa = NOUN “head” with alternate PL (the pluralizer suffix -pa).
    if (direct && (m.morph_type === "suffix" || m.morph_type === "prefix")) {
      const bareFold = foldToken(String(key).replace(/^-+/, "").split("-")[0]);
      if (bareFold && bareFold !== rec.key_fold) addCandidate({ ...rec, key_fold: bareFold });
    }
  }
}

// Generated morphology surface fallback. Most important in practice: possessed
// nouns (macihi, yupihi, kotanu…) inherit the base noun's gloss. We only fill
// surfaces that do not already have a direct morpheme DB entry, so okere/okére
// stays the verb “finish” and never gets a spurious possessive label.
let formRows = [];
if (existsSync(FORMS)) {
  formRows = readFileSync(FORMS, "utf8")
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
const generatedBySurface = new Map();
for (const f of formRows) {
  const surfaceFold = f.surface_fold || foldToken(f.surface ?? "");
  if (!surfaceFold) continue;
  const base = entryByFold.get(f.lemma_fold || foldToken(f.lemma ?? ""));
  if (!base) continue;
  const gloss = cleanGloss(first(base.glosses_en));
  const glossJp = first(base.glosses_jp);
  const pos = posDisplay(base, gloss);
  if (!gloss && !glossJp && !pos) continue;
  // Prefer exact/attested base lexemes with concise lexical glosses. This makes
  // ambiguous macihi choose maci “wife” over the broader mat “woman/wife”.
  let score = 100 + Math.round((Number(f.confidence ?? 0) || 0) * 100);
  if (f.source === "attested") score += 60;
  if (f.source === "exception") score += 50;
  if (f.source === "rule") score += 10;
  if (String(f.relation) === "possessed") score += 40;
  if (String(base.lemma ?? "") === String(f.lemma ?? "")) score += 20;
  if (String(first(base.glosses_en) ?? "").includes("POSS")) score += 150;
  if (gloss && !gloss.includes("/") && !gloss.includes("…")) score += 10;
  score += Math.min(Number(base.frequency ?? 0), 9999) / 1000;
  const rec = {
    key_fold: surfaceFold,
    key: normToken(f.surface ?? surfaceFold),
    lemma: base.lemma ?? f.lemma ?? null,
    category: base.category ?? null,
    morph_type: f.relation ?? "generated",
    pos_display: pos,
    gloss_en: gloss,
    gloss_jp: glossJp,
    source_id: `${base.id ?? base.lemma}:${f.relation ?? "form"}`,
    priority: Math.round(score),
  };
  const prev = generatedBySurface.get(surfaceFold);
  if (!prev || rec.priority > prev.priority) generatedBySurface.set(surfaceFold, rec);
}
let generatedAdded = 0;
for (const rec of generatedBySurface.values()) {
  // Fill only missing fields. If the direct entry exists but lacks a gloss/POS,
  // borrow just the absent field from the generated form — never replace the
  // whole record (that would drop a good gloss to gain a POS, or vice versa).
  const prev = best.get(rec.key_fold);
  if (!prev) {
    best.set(rec.key_fold, rec);
    generatedAdded++;
  } else if ((!prev.gloss_en && rec.gloss_en) || (!prev.pos_display && rec.pos_display)) {
    best.set(rec.key_fold, {
      ...prev,
      gloss_en: prev.gloss_en ?? rec.gloss_en,
      gloss_jp: prev.gloss_jp ?? rec.gloss_jp,
      pos_display: prev.pos_display ?? rec.pos_display,
    });
    generatedAdded++;
  }
}

// Possessed-noun marking (display convention "GLOSS.～の" / "GLOSS.POSS",
// as already carried by attested rows like macihi 妻.～の). Two sources:
// generated-form rows with relation=possessed, and unambiguous long-form
// possessives detected structurally — surface = noun base + hV with vowel
// harmony (po→poho, re→rehe). Direct dictionary entries (poho 子) get the
// mark too: the form IS possessive regardless of which row supplied the gloss.
{
  const possSurfaces = new Set();
  for (const f of formRows) {
    if (String(f.relation) === "possessed") {
      const sf = f.surface_fold || foldToken(f.surface ?? "");
      if (sf) possSurfaces.add(sf);
    }
  }
  const isNoun = (r) => !r.pos_display || /^(NOUN|N)\b/.test(r.pos_display);
  for (const [k, r] of best) {
    if (!possSurfaces.has(k)) {
      // structural long form: base + h + harmonic vowel over an attested noun
      const m = /^(.+[aeiou])h([aeiou])$/.exec(k);
      if (!m || m[1].slice(-1) !== m[2]) continue;
      // the base must have a noun reading — the top display entry may be a
      // homograph (re 'three' NUM hides re 'name' N behind rehe)
      const baseTop = best.get(m[1]);
      const baseNounInDb = rows.some((e) =>
        foldToken(e.lemma ?? "") === m[1] && String(e.category ?? "").startsWith("n"));
      if ((!baseTop || !isNoun(baseTop)) && !baseNounInDb) continue;
      if (!isNoun(r)) continue;
    } else if (!isNoun(r)) continue;
    if (r.gloss_jp && !r.gloss_jp.includes("～の") && !r.gloss_jp.startsWith("…の")) r.gloss_jp = `${r.gloss_jp}.～の`;
    if (r.gloss_en && !/\.POSS\b|his\/her|one's/.test(r.gloss_en)) r.gloss_en = `${r.gloss_en}.POSS`;
  }
}

// Curated surface aliases backed by morpheme DB entries. These handle common
// orthographic segmentations where the corpus token is a bare grammatical form
// or a very frequent source orthography not yet present as DB allomorph.
function forceFrom(sourceId, key, gloss, pos = undefined) {
  const m = rows.find((r) => r.id === sourceId);
  if (!m) {
    // These encode specific, previously-diagnosed fixes; a silent no-op on a
    // renamed/removed DB id would let the regression reappear undetected.
    console.warn(`forceFrom: source id "${sourceId}" not found — override "${key}" skipped`);
    return;
  }
  const keyFold = foldToken(key);
  const displayGloss = gloss ?? cleanGloss(first(m.glosses_en));
  best.set(keyFold, {
    key_fold: keyFold,
    key: normToken(key),
    lemma: m.lemma ?? null,
    category: m.category ?? null,
    morph_type: m.morph_type ?? null,
    pos_display: pos === undefined ? posDisplay(m, displayGloss) : pos,
    gloss_en: displayGloss,
    gloss_jp: first(m.glosses_jp),
    source_id: m.id,
    priority: 100_000_000, // curated override: always wins
  });
}
forceFrom("-p-nmlz", "p", "NMLZ", "PART");
forceFrom("-pe-nmlz", "pe", "NMLZ", "PART");
forceFrom("-no-adv", "no", "ADVZ", "PART");
forceFrom("-utar", "utar", "people", "NOUN");
forceFrom("-utar", "utara", "people", "NOUN");
forceFrom("-irukay", "irukay", "for a while", "PART");
// High-frequency orthographic/source aliases confirmed against the morpheme DB.
forceFrom("kusu", "gusu", "because", "PART");
forceFrom("sinuma", "shinuma", "3SG", "PRON");
forceFrom("eci=", "echi", "2PL.A=", "PERS");
forceFrom("kur", "guru", "person", "NOUN");
forceFrom("somo", "shomo", "NEG", "ADV");
forceFrom("ciki", "chiki", "if", "PART");
forceFrom("sekor", "sekoro", "QUOT", "REL");
forceFrom("aynu", "ainu", "human", "NOUN");
forceFrom("kamuy", "kamui", "god", "NOUN");
forceFrom("mosir", "moshiri", "land", "NOUN");
forceFrom("okay", "okai", "exist", "VI");
forceFrom("ney", "nei", "where", "PRON");
forceFrom("tanpe", "tambe", "this", "NOUN");
forceFrom("newaanpe", "neampe", "that one", "PRON");
forceFrom("ayke", "aige", "then", "SCONJ");
forceFrom("ota", "ohta", "set at", "VD");
// Detached personal object clitic: the corpus writes `en=` (1SG.O) bare as `en`.
forceFrom("en=", "en");
// High-frequency epenthetic / voiced source spellings of unambiguous words.
// Additive/focus particle `ka` (“also, even; (not) … at all”). Very frequent
// but absent from the morpheme DB, so it has no source entry to draw from.
function forceLiteral(key, gloss, pos, lemma = null) {
  const keyFold = foldToken(key);
  best.set(keyFold, {
    key_fold: keyFold,
    key: normToken(key),
    lemma: lemma ?? key,
    category: null,
    morph_type: "curated",
    pos_display: pos,
    gloss_en: gloss,
    gloss_jp: null,
    source_id: `curated:${key}`,
    priority: 100_000_000, // curated override: always wins
  });
}
forceLiteral("ka", "also", "PART");
forceFrom("kor", "koro");        // kor “have” with echo vowel
forceFrom("korka", "koroka");    // korka “but”
forceFrom("opitta", "obitta");   // opitta “all” (p→b voicing)

// ── Coverage pass 1: normalize personal-clitic display glosses to Leipzig
// labels so composed tokens below read `4.A=see`, not `someone see`.
forceLiteral("an=", "4.A=", "PERS");        // a= variant after consonant stems
forceLiteral("k=", "1SG.A=", "PERS");       // reduced ku=
forceLiteral("c=", "1PL.EXC.A=", "PERS");   // reduced ci=
forceLiteral("un=", "1PL.EXC.O=", "PERS");

// ── Coverage pass 2: Batchelor Bible orthography (voiced stops, ch/sh, echo
// vowels) mapped onto attested morpheme-DB lemmas. Verified against context:
// the Bible corpus never uses e.g. shui as the verb “shake”.
forceFrom("nukar", "nukara");    // see
forceFrom("pirka", "pirika");    // be good
forceFrom("cise", "chisei");     // house
forceFrom("kanto", "kando");     // sky
forceFrom("arki", "araki");      // come.PL
forceFrom("irenka", "irenga");   // will/law
forceFrom("irwak", "iriwak");    // siblings
forceFrom("kewtum", "keutum");   // spirit/mind
forceFrom("utarpa", "utarapa");  // chief
forceFrom("etok", "etoko");      // before/front (possessed)
forceFrom("mosma", "moshima");   // other
forceFrom("hawean", "hawan", "say", "VI");   // haw'an
forceFrom("inanpe", "inambe", "which one", "PRON");
forceLiteral("shui", "again", "ADV");        // Batchelor suy (adv; DB has only the verb)
forceLiteral("okaibe", "things", "NOUN");    // okay pe “existing things”
forceLiteral("ambe", "thing", "NOUN");       // an pe “the thing that is” (NOT anpe “truth”)
forceLiteral("reihei", "name", "NOUN");      // Batchelor rei(hei)
forceLiteral("chikoro", "our", "PERS");      // ci= koro “our (Father)”
forceLiteral("yesu", "Jesus", "PROPN");
forceLiteral("kiristo", "Christ", "PROPN");
forceLiteral("ehoba", "Jehovah", "PROPN");

// ── Coverage pass 3: Sakhalin folktale (Asai Take) orthography + converbs and
// the standard folktale protagonists. Long vowels are written double; -h final.
forceLiteral("teh", "and", "SCONJ");         // Sakhalin converb (= wa)
forceLiteral("nah", "QUOT", "PART");         // Sakhalin quotative/manner (= sekor)
forceLiteral("neeteh", "and then", "SCONJ"); // nee + teh
forceLiteral("nean", "that", "ADN");         // ne'an “that (aforementioned)”
forceLiteral("anoka", "I/we", "PRON");       // Sakhalin independent pronoun
forceLiteral("horokewpo", "young wolf", "NOUN");   // folktale hero
forceLiteral("monimahpo", "young woman", "NOUN");  // folktale heroine
forceLiteral("shomoki", "not do", "V");      // somo ki
forceFrom("ye", "yee");                      // say (long vowel)
forceFrom("ne", "nee");                      // COP (long vowel)
forceFrom("ki", "kii");                      // do (long vowel)

// ── Coverage pass 4: pan-dialect converbs missing from the morpheme DB.
forceLiteral("ike", "and then", "PART");     // (h)ike converb: oka=an ike …
forceLiteral("yayne", "until finally", "SCONJ");
forceLiteral("oshiketa", "inside", "NOUN");  // Batchelor o-sike-ta “in the inside of”

// ── Coverage pass 5 (context-verified batch 2).
// Batchelor Bible voicing/echo-vowel spellings backed by DB lemmas:
forceFrom("ipe", "ibe");            // eat: “tope ibe” drink milk
forceFrom("sanke", "sange");        // bring down: “itak sange”
forceFrom("koykar", "koikara");     // imitate: “wenbe iteki koikara”
forceFrom("kar", "kara");           // make (echo vowel)
forceFrom("kor", "kora");           // have/'s: “Kamui kora kenru”
forceFrom("iteki", "itekke", "PROH", "ADV");  // “itekke irara yan”
forceLiteral("yaikota", "oneself", "ADV");    // “shinuma yaikota” he himself
forceLiteral("oupeka", "upright", "ADV");     // “oupeka an itak” just words
forceLiteral("nekon", "how", "ADV");          // “nekon ne hawe tapan”
forceLiteral("newa", "and", "CCONJ");         // NP-coordinating “A newa B”
forceLiteral("ikip", "deed", "NOUN");         // iki + p “that which one does”
// Sakhalin (Asai Take) forms:
forceLiteral("neya", "that", "ADN");          // “neya monimahpo” the aforesaid
forceLiteral("utah", "people", "NOUN");       // utar with r→h
forceLiteral("kuski", "FUT", "AUX");          // kusu iki contraction: “sat kuski”
forceLiteral("kun", "should", "PART");        // kuni reduced: “an-ki kun ki kusu”
forceLiteral("manuyke", "and then", "PART");  // manu + ike hearsay converb
forceLiteral("payeka", "go around", "V");     // paye + ka
// Dialogue/edition artifacts, verified in context:
forceLiteral("aa", "ah", "INTJ");             // “B: aa, hawe ne ciki …”
forceLiteral("u", "FILLER", "INTJ");          // yukar metric vocable: “V u poknamosir”
forceLiteral("v", "(verse)", "X");            // yukar line marker
forceLiteral("b", "(speaker)", "X");          // dialogue speaker label “B:”

// ── Owner-decided glosses (mkpoli, 2026-07-04):
forceLiteral("konno", "while", "SCONJ");        // yukar kor-no temporal converb
forceLiteral("sirkunpato", "(refrain)", "X");   // kamuy-yukar sakehe
forceLiteral("heino", "(refrain)", "X");        // kamuy-yukar sakehe
forceLiteral("aokai", "you", "PRON");           // Batchelor a-okai 2nd person (NOT a+okai)
// Owner batch 2 (2026-07-04, verified in ../ainu-dictionaries + corpus):
forceLiteral("eino", "(refrain)", "X");         // heino family — repeats through a performance
forceLiteral("hemnoye", "(refrain)", "X");      // 448 occ / 2 sources, line-initial sakehe
forceLiteral("nope", "(refrain)", "X");         // 208 occ / 1 source, line-initial sakehe
forceLiteral("ounno", "from then on", "ADV");   // 静内【後副】～からずっと; FF-Ainu それから
forceLiteral("korsi", "child", "NOUN");         // 静内 korsi 子ども
forceLiteral("tuitak", "tale", "NOUN");         // = tuytak 散文説話 (FRPAC Ishikari/Tokachi)
forceLiteral("tuytak", "tale", "NOUN");
forceLiteral("eattukonnaan", "how amazing", "ADV"); // 静内 eattukonna(~an) なんとまあ
forceLiteral("eattukonna", "how amazing", "ADV");

// ── Coverage pass 6 (context-verified batch 3).
// Batchelor Bible:
forceFrom("kampi", "kambi", "letter", "NOUN");   // DB gloss “bookkeeper” is wrong here
forceFrom("puri", "buri");                       // behavior/custom
forceFrom("kor", "goro");                        // “Ku goro poho” my sons
forceLiteral("katpak", "sin", "NOUN");           // Batchelor coinage: “a=kor katpak e=tusare”
forceLiteral("eishokoro", "believe", "VT");      // “Eishokoro okere utara” those who believed
forceLiteral("shiwentep", "widow", "NOUN");
forceLiteral("ushike", "place", "NOUN");         // us-i-ke: “ashkanne ushike” clean place
forceLiteral("tumugeta", "among", "ADV");        // tum-ke-ta: “nei utara tumugeta”
forceLiteral("yudea", "Judea", "PROPN");
// Yukar/classic:
forceLiteral("enta", "Q", "PART");               // “hawe enta ka” emphatic interrogative
// Sakhalin:
forceLiteral("acahcipo", "old woman", "NOUN");   // folktale grandmother
forceLiteral("okore", "all", "ADV");             // “'okore campoho ne karahci”
forceLiteral("monaa", "sit", "VI");              // “monaa=an wa inkar=an”

// ── Coverage pass 7 (context-verified batch 4).
// Sakhalin:
forceLiteral("koh", "while", "SCONJ");         // kor with r→h: “niina koh kuru”
forceLiteral("tah", "that", "PRON");           // “tah kii nukaraha” did that
forceLiteral("hemata", "what", "PRON");        // “hemata yuukara hawehe”
forceLiteral("omantene", "after a while", "SCONJ"); // “teh 'omantene 'orowa”
forceLiteral("iineahsuy", "hey", "INTJ");      // “'iine'ahsuy yuhpo yuhpo”
forceLiteral("hawoka", "say.PL", "VI");        // “sekor hawoka” (haweoka)
forceLiteral("tewano", "from now", "ADV");     // “Tewano ecikki en=kohanke!”
forceLiteral("iokunnuka", "good heavens", "INTJ"); // “Haypo! Iokunnuka!”
// Batchelor Bible:
forceLiteral("ande", "put", "VT");             // “tekehe ande-hi” laying hands
forceLiteral("kashiobiuki", "save", "VT");     // kasi-opiwki “salvation”
forceLiteral("iyohaichish", "psalm", "NOUN");  // “Iyohaichish 62” = Psalm 62
forceLiteral("uirup", "kin", "NOUN");          // “uirup koro” have kindred
forceLiteral("guranak", "person TOP", "NOUN"); // gur’anak = guru + anakne fused
forceLiteral("eishokor", "believe", "VT");     // eishokoro variant

// ── Coverage pass 8 (batch 5 — verified in ../ainu-dictionaries/rag_export,
// mostly Batchelor's own dictionary entries).
forceLiteral("koropare", "give", "VD");        // Batchelor: to give, bestow
forceLiteral("epokba", "hate", "VT");          // Batchelor: to persecute, hate
forceLiteral("paweteshu", "greet", "VT");      // Batchelor: to salute, greet
forceLiteral("uweingara", "prophesy", "VT");   // Batchelor: to prophesy (-guru prophet)
forceLiteral("koipishi", "judge", "VT");       // Batchelor: to judge, enquire into
forceLiteral("pakihi", "time", "NOUN");        // Batchelor: パキヒ 時 (“the time is near”)
forceLiteral("pokon", "as if", "PART");        // 静内 まるで～するみたいに
forceLiteral("hemanda", "what", "PRON");       // hemanta voiced
forceFrom("inkar", "ingara");                  // look (Batchelor echo vowel)
forceLiteral("ingaran", "behold", "INTJ");     // ingar’an “Lord, behold”
forceLiteral("rapoketa", "during", "ADV");     // rapok-ke-ta
forceFrom("ni", "nii");                        // Sakhalin long vowel: “yan nii kaata”
forceLiteral("yuhpo", "elder brother", "NOUN");// Sakhalin: “'iine'ahsuy yuhpo yuhpo”
forceLiteral("e.", "yes", "INTJ");             // dialogue “B: E. Ku=merayke.”
forceLiteral("yoannes", "John", "PROPN");      // III Yoannes = III John
forceFrom("i=", "i");                          // detached 4.O clitic: “i-koyki”

// ── Batchelor fused a-passive (owner decision: curated list only, no auto-rule
// because a+VERB collides with real words — apa “door”, aokai “you”). Each
// verified in context; gloss composes 4.A= + the stem's gloss at build time so
// it stays in sync (anuye → 4.A=carve “written”, akore → 4.A=give “given”).
for (const fused of ["akore", "anukara", "akara", "aesanniyo", "aisamka", "anunuke",
  "anuye", "aokere", "auweomare", "aomare", "akire", "aeshik", "aashte", "aeramushinne"]) {
  const stem = best.get(foldToken(fused.slice(1)));
  if (!stem?.gloss_en) {
    console.warn(`a-passive: stem for "${fused}" has no gloss — skipped`);
    continue;
  }
  best.set(foldToken(fused), {
    key_fold: foldToken(fused), key: fused, lemma: stem.lemma ?? null,
    category: stem.category ?? null, morph_type: "a-passive",
    pos_display: stem.pos_display ?? null, gloss_en: `4.A=${stem.gloss_en}`,
    gloss_jp: null, source_id: `a=+${stem.source_id}`, priority: 100_000_000,
  });
}

// Lexeme-bank fill-only fallback. The morpheme DB is the curated source of truth
// and always wins; the lexeme bank (~15.8k dictionary lexemes) only fills folds
// the morpheme DB left without a gloss — content words like folktale vocabulary.
// It never overrides an existing gloss, so it cannot re-introduce the bare-affix
// or homograph mis-picks fixed above.
let lexemeAdded = 0;
if (existsSync(LEX)) {
  const lex = JSON.parse(readFileSync(LEX, "utf8"));
  // Normalize lexeme POS codes onto the same categories posDisplay() understands.
  const posAlias = { int: "intj", post: "postp" };
  // Collect the best candidate lexeme per fold (highest English-gloss confidence,
  // then a real POS), so we choose one reading deterministically.
  const lexBest = new Map();
  for (const r of lex) {
    // Skip bound morphemes/affixes: a bare corpus token is a free word, and
    // exposing an affix lemma as a bare key is exactly the trap avoided above.
    if (r.bound === true) continue;
    const pos = String(r.pos ?? "").toLowerCase();
    if (pos === "sfx" || pos === "pfx") continue;
    const gloss = cleanGloss(first(r.gloss_en));
    const glossJp = first(r.gloss_jp);
    if (!gloss && !glossJp) continue;
    const pseudo = { category: posAlias[pos] ?? pos, morph_type: "root", category_alt: [] };
    const posDisp = posDisplay(pseudo, gloss);
    const conf = Number(r.gloss_en_confidence ?? 0) || 0;
    const score = conf * 10 + (posDisp ? 1 : 0);
    for (const k of [r.lemma, ...(r.aliases ?? []), String(r.id ?? "").split(".")[0]]) {
      if (!k) continue;
      for (const equivalent of equivalentForms(String(k))) {
        const f = foldToken(equivalent);
        if (!f) continue;
      // Every lexeme sense is a possible ALTERNATE reading (ranked below the
      // morpheme-DB readings via negative priority) — this is what surfaces
      // pa = mouth / year alongside head / PL.
        if (gloss) addCandidate({ key_fold: f, pos_display: posDisp, gloss_en: gloss, category: pos || null, priority: -1000 + conf });
        const prev = lexBest.get(f);
        if (!prev || score > prev.score) {
          lexBest.set(f, {
            score,
            rec: {
              key_fold: f,
              key: normToken(equivalent),
              lemma: r.lemma ? canonicalLemma(r.lemma) : null,
              category: pos || null,
              morph_type: "lexeme",
              pos_display: posDisp,
              gloss_en: gloss,
              gloss_jp: glossJp,
              source_id: `lexeme:${r.id ?? k}`,
              priority: 0,
            },
          });
        }
      }
    }
  }
  for (const { rec } of lexBest.values()) {
    const prev = best.get(rec.key_fold);
    if (!prev) {
      best.set(rec.key_fold, rec);
      lexemeAdded++;
    } else if (!prev.gloss_en && rec.gloss_en) {
      // DB had a POS but no gloss — keep its POS, borrow the lexeme gloss.
      best.set(rec.key_fold, { ...prev, gloss_en: rec.gloss_en, gloss_jp: prev.gloss_jp ?? rec.gloss_jp });
      lexemeAdded++;
    }
  }
}

// Corpus-driven fill for token shapes the DB can never list directly:
//   a) clitic-composed tokens (an=nukar, k=arpa, itak=an) — compose the gloss
//      from the personal clitic + the stem: 4.A= + see → “4.A=see”.
//   b) underscore variants (h_ine, w_a, an_=se) — the corpus marks a latent
//      segment with “_”; the plain form carries the same sense.
// Reads DISTINCT surface folds from build/corpus.db (skipped when absent, e.g.
// in CI). Fill-only: never touches folds that already have a gloss.
const CORPUS_DB = new URL("../build/corpus.db", import.meta.url).pathname;
let composedAdded = 0, underscoreAdded = 0;
if (existsSync(CORPUS_DB)) {
  const { Database } = await import("bun:sqlite");
  const cdb = new Database(CORPUS_DB, { readonly: true });
  const folds = cdb
    .query("SELECT DISTINCT surface_fold f FROM corpus_tokens WHERE surface_fold GLOB '*[a-z]*'")
    .all()
    .map((r) => r.f);
  cdb.close();
  const isPers = (r) => r && (r.category === "pers" || r.morph_type === "clitic" || r.pos_display === "PERS");
  for (const fold of folds) {
    const prev = best.get(fold);
    if (prev?.gloss_en) continue;
    const plain = fold.replace(/_/g, "");

    // b) pure underscore variant of a known word.
    if (plain !== fold && !plain.includes("=")) {
      const base = best.get(plain);
      if (base?.gloss_en) {
        best.set(fold, { ...base, key_fold: fold, key: fold, morph_type: "underscore", source_id: `${base.source_id}:underscore`, priority: 0, alternates: null });
        underscoreAdded++;
      }
      continue;
    }

    // c) Sakhalin plural -hci / -ahci on a known verb: okayahci → exist.PL,
    //    karahci → make.PL. Verb stems only, so noun homographs never match.
    if (!plain.includes("=") && plain.length > 4 && plain.endsWith("hci")) {
      const VPOS = new Set(["VI", "VT", "VD", "VC", "V", "AUX"]);
      for (const stemFold of [plain.slice(0, -3), plain.slice(0, -4)]) {
        const base = best.get(stemFold);
        // Verb stems only — except okay “exist(.PL)”, which the DB tags PRON.
        if (!base?.gloss_en || !(VPOS.has(base.pos_display ?? "") || /^exist/.test(base.gloss_en))) continue;
        const g = base.gloss_en.endsWith(".PL") ? base.gloss_en : base.gloss_en + ".PL";
        best.set(fold, { ...base, key_fold: fold, key: fold, gloss_en: g, morph_type: "hci-plural", source_id: `${base.source_id}:hci`, priority: 0, alternates: null });
        composedAdded++;
        break;
      }
      if (best.get(fold)?.gloss_en) continue;
    }

    // a) single personal clitic + stem (either order), after underscore strip.
    if (plain.split("=").length !== 2) continue;
    const [p0, p1] = plain.split("=");
    if (!p0 || !p1) continue;
    let clitic = best.get(`${p0}=`), stem = best.get(p1), composedGloss = null, stemRec = null;
    if (isPers(clitic) && clitic.gloss_en && stem?.gloss_en) {
      const cg = clitic.gloss_en.endsWith("=") ? clitic.gloss_en : clitic.gloss_en + "=";
      composedGloss = cg + stem.gloss_en;
      stemRec = stem;
    } else {
      stem = best.get(p0);
      const enc = best.get(`=${p1}`);
      if (stem?.gloss_en && isPers(enc) && enc.gloss_en) {
        const eg = enc.gloss_en.startsWith("=") ? enc.gloss_en : "=" + enc.gloss_en;
        composedGloss = stem.gloss_en + eg;
        stemRec = stem;
        clitic = enc;
      }
    }
    if (!composedGloss) continue;
    best.set(fold, {
      key_fold: fold,
      key: fold,
      lemma: stemRec.lemma ?? null,
      category: stemRec.category ?? null,
      morph_type: "composed",
      pos_display: stemRec.pos_display ?? null,
      gloss_en: composedGloss,
      gloss_jp: null,
      source_id: `${clitic.source_id}+${stemRec.source_id}`,
      priority: 0,
      alternates: null,
    });
    composedAdded++;
  }
}

// Attach up to ALT_MAX alternate homograph readings to each displayed winner. An
// alternate is a distinct attested reading (different POS *or* gloss) that lost
// the display slot — e.g. pa shows NOUN “head” with alt PL; kane shows “somewhat”
// with alt NOUN “metal”. Consumers can surface these without another lookup.
const ALT_MAX = 4;
const normGloss = (g) => String(g ?? "").toLowerCase().replace(/[.\s]+$/, "").trim();
for (const rec of best.values()) {
  // Dedup alternates by gloss meaning (not by POS): the lexeme bank yields the
  // same sense under several junk POS tags (kane → gold×3), and a derivational
  // suffix often just restates the winner (nu → “hear”). Keep the first, i.e.
  // highest-priority, instance of each distinct gloss and drop the winner's own.
  const seen = new Set([normGloss(rec.gloss_en)]);
  const alts = [];
  for (const c of (candidates.get(rec.key_fold) ?? []).sort((a, b) => b.priority - a.priority)) {
    const ng = normGloss(c.gloss_en);
    if (!ng || seen.has(ng)) continue;
    // Drop editorial/cross-reference glosses that are not word senses:
    // "[Used after words…]", "[direct quote]", "see ka kik".
    if (/^[[(]/.test(c.gloss_en) || /^see /i.test(c.gloss_en)) continue;
    seen.add(ng);
    alts.push({ p: c.pos_display ?? null, g: c.gloss_en, mc: c.category ?? null });
    if (alts.length >= ALT_MAX) break;
  }
  rec.alternates = alts.length ? JSON.stringify(alts) : null;
}

const out = [...best.values()].sort((a, b) => a.key_fold.localeCompare(b.key_fold));
writeFileSync(OUT, out.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`morph_gloss: ${out.length} rows -> ${OUT.pathname}`);
console.log(`generated-form fallbacks: ${generatedAdded} rows from ${FORMS.pathname}`);
console.log(`lexeme-bank fill-only fallbacks: ${lexemeAdded} rows from ${LEX.pathname}`);
console.log(`corpus-driven fills: ${composedAdded} clitic-composed, ${underscoreAdded} underscore variants`);
for (const k of ["a=", "=an", "ku=", "p", "pe", "no", "kor", "rayke", "ronnu", "okere", "okére", "macihi", "te"]) {
  const r = best.get(foldToken(k));
  console.log(`  ${k}: ${r?.pos_display ?? "—"} ${r?.gloss_en ?? "—"} (${r?.source_id ?? "—"})`);
}

console.log("\nlongest remaining display glosses:");
for (const [i, r] of out
  .filter((r) => r.gloss_en)
  .sort((a, b) => b.gloss_en.length - a.gloss_en.length || a.key_fold.localeCompare(b.key_fold))
  .slice(0, 20)
  .entries()) {
  console.log(`  ${String(i + 1).padStart(2)}. ${r.key_fold.padEnd(22)} ${String(r.gloss_en.length).padStart(2)}  ${r.gloss_en}  (${r.source_id})`);
}
