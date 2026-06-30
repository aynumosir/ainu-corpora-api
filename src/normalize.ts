/**
 * Shared text-normalization for the Ainu corpus token layer.
 *
 * There are THREE levels of normalization, each a strict superset of the last:
 *
 *   surface       — token exactly as it appears in the sentence ("Néa", "a=").
 *   surface_norm  — lowercased + surrounding apostrophes stripped ("néa", "a=").
 *                   This is what `corpus_tokens.surface_norm` stores (see
 *                   scripts/build_tokens.py `norm()` — kept byte-identical).
 *   surface_fold  — surface_norm with pitch/length diacritics folded away and
 *                   apostrophe/equals variants unified ("nea", "a="). This is
 *                   the accent-insensitive search key.
 *
 * Why fold? Ainu romanization marks PITCH ACCENT with acute (á é í ó ú) and, in
 * some Sakhalin sources, vowel LENGTH with circumflex/macron (â/ā). These are
 * prosodic, not segmental — "néa" and "nea" are the same word. A learner who
 * types "ramat" should still find "rámat". Folding makes the corpus key
 * accent-insensitive while `surface`/`surface_norm` preserve the original for
 * display. This is the answer to "are we normalizing correctly?": KWIC node
 * lookups should match on the folded key by default.
 */

// Combining marks (U+0300–U+036F covers acute, grave, circumflex, macron,
// breve, diaeresis…) — removed after NFD so "é"→"e", "â"→"a", "ā"→"a".
const COMBINING = /[\u0300-\u036f]/g;
// Edge apostrophes (matches scripts/build_tokens.py EDGE_APOS).
const EDGE_APOS = /^['’"]+|['’"]+$/g;
// Apostrophe / glottal-stop variants (straight ', curly ’, modifier ʼ ʻ, ` ´).
// In the Murasaki Kyoko transcriptions of 浅井 タケ (Sakhalin) the apostrophe is
// used to write the GLOTTAL STOP — both as a standalone token (between words)
// and word-internally ("ne'ampe", "haw'as", "an='e"). Glottal onset before a
// vowel is largely predictable in Ainu, and the SAME word is written with or
// without it across sources. So for the accent/orthography-insensitive FOLD key
// we DROP these marks entirely ("ne'ampe" → "neampe", "'isam" → "isam"), which
// makes search match across transcription conventions. The original is kept in
// `surface` / `surface_norm` for display. The clitic boundary "=" is structural
// (not a glottal stop) and is preserved.
const APOS_VARIANTS = /['’ʼʻ`´]/g;

/** surface_norm: lowercase + strip surrounding apostrophes. Mirrors the Python
 * `norm()` used at build time so query keys line up with the stored column. */
export function normToken(s: string): string {
  return s.toLocaleLowerCase("en").replace(EDGE_APOS, "");
}

/**
 * Fold a string's pitch/length diacritics and unify apostrophe variants.
 * NFD-decompose, drop combining marks, then DELETE every glottal-stop
 * apostrophe glyph (see APOS_VARIANTS). The clitic boundary "=" is preserved
 * (it is structural, not punctuation). Does NOT lowercase or strip edges.
 */
export function foldAccents(s: string): string {
  return s
    .normalize("NFD")
    .replace(COMBINING, "")
    .replace(APOS_VARIANTS, "")
    .normalize("NFC");
}

/** The accent-insensitive search key: normToken + foldAccents. Both the stored
 * `surface_fold` column and any user query are run through THIS so they meet. */
export function foldToken(s: string): string {
  return foldAccents(normToken(s));
}

/** Whether a token is a clitic (Ainu personal affixes etc. carry a "=" edge). */
export function isClitic(s: string): boolean {
  return s.startsWith("=") || s.endsWith("=");
}

/**
 * Whether a token carries no segmental content — i.e. it is a standalone
 * glottal-stop / apostrophe / quote marker (its folded form is empty but it is
 * not a normal punctuation mark like "." or ","). These appear as their own
 * tokens in the Murasaki Sakhalin transcriptions and are noise in KWIC context
 * and collocation; callers use this to de-emphasise or exclude them.
 */
export function isGlottalMarker(surface: string): boolean {
  if (!surface) return false;
  // Only apostrophe/quote glyphs (optionally repeated) and nothing else.
  return /^['’ʼʻ`´"]+$/.test(surface);
}
