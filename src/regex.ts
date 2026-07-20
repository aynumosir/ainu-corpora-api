/**
 * Word-based regular-expression search: `match=regex` on /v1/kwic and `/re/`
 * slots in /v1/structural patterns (e.g. `/ech?i/ /^a/` = a word matching
 * ech?i followed by a word starting with a).
 *
 * SQLite (D1 / libSQL over HTTP) has no REGEXP function, so the regex never
 * runs in SQL. Instead the pattern is resolved IN THE WORKER against the
 * corpus vocabulary — the distinct folded word keys — and the matching keys
 * feed the same `key IN (…)` node search the fold/expand paths already use:
 *
 *   /ech?i/ → vocab scan → {echi, eci=, eci, hecire, …} → t.surface_fold IN (…)
 *
 * Matching is grep-style: case-insensitive, UNANCHORED within the word (use
 * ^ and $ to anchor), applied to the FOLDED key (accents and glottal-stop
 * apostrophes removed — see normalize.ts), so /ech?i/ also finds
 * accent-marked spellings.
 *
 * The vocab scan is narrowed with a LIKE filter derived from the regex when a
 * literal substring is guaranteed in every match (/ech?i/ → LIKE '%ec%'), and
 * memoized per db instance so kwic() + kwicTotal() (which run concurrently on
 * the same request-scoped db) share one scan.
 */

import { foldAccents } from "./normalize.js";

/** Invalid user regex — routes turn this into a 400 rather than a 500. */
export class BadRegexError extends Error {
  constructor(source: string, cause: string) {
    super(`invalid regex /${source}/: ${cause}`);
    this.name = "BadRegexError";
  }
}

/** Compile a user word-regex: case-insensitive, unanchored. The `u` flag is
 * preferred (correct casefolding over the full alphabet) but some legacy
 * patterns are only valid without it, so fall back before rejecting.
 *
 * Rejects patterns that can cause catastrophic backtracking in the
 * (non-linear-time) JS regex engine — a quantified group whose body already
 * contains a quantifier, e.g. `(a+)+`, `(a*)*`, `([a-z]+)*`, `(a+){2,}`.
 * These would pin the Worker CPU on the vocab scan (issue #24 / ReDoS). */
const MAX_REGEX_LEN = 200;
const NESTED_QUANTIFIER = /\([^()]*(?:[+*]|\{\d+,?\d*\})[^()]*\)(?:[+*]|\{\d+,?\d*\})/;

export function compileWordRegex(source: string): RegExp {
  const src = source.trim();
  if (!src) throw new BadRegexError(source, "empty pattern");
  if (src.length > MAX_REGEX_LEN) {
    throw new BadRegexError(source, `pattern too long (max ${MAX_REGEX_LEN} chars)`);
  }
  if (NESTED_QUANTIFIER.test(src)) {
    throw new BadRegexError(source, "nested quantifiers can cause catastrophic backtracking");
  }
  try {
    return new RegExp(src, "iu");
  } catch {
    try {
      return new RegExp(src, "i");
    } catch (e) {
      throw new BadRegexError(src, e instanceof Error ? e.message : String(e));
    }
  }
}

/**
 * A literal substring guaranteed to appear in EVERY match of the regex, used
 * to narrow the vocab scan with `LIKE '%lit%'` before the JS regex filter.
 * Conservative: anything uncertain (alternation, groups, escapes, quantified
 * chars) breaks the literal run or bails entirely — returning "" just means a
 * full vocab scan, never a wrong result. Runs shorter than 2 chars don't
 * narrow anything and are dropped.
 */
export function requiredLiteral(source: string): string {
  // Alternation/groups: a literal from one branch isn't in every match — bail.
  if (/[|()]/.test(source)) return "";
  let best = "";
  let cur = "";
  const flush = () => {
    if (cur.length > best.length) best = cur;
    cur = "";
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (/[\p{L}\p{N}=-]/u.test(ch)) {
      // A following quantifier makes this char optional (?, *, {…}) or breaks
      // adjacency with what comes after (+): end the run accordingly.
      if (next === "?" || next === "*" || next === "{") { flush(); continue; }
      if (next === "+") { cur += ch; flush(); i++; continue; }
      cur += ch;
      continue;
    }
    flush();
    if (ch === "\\") i++; // escape: skip the escaped char (could be a class like \d)
    else if (ch === "[") {
      i++;
      while (i < source.length && source[i] !== "]") i += source[i] === "\\" ? 2 : 1;
    } else if (ch === "{") {
      while (i < source.length && source[i] !== "}") i++;
    }
  }
  flush();
  return best.length >= 2 ? best : "";
}

/** Most distinct word keys a regex may resolve to. Frequency-ordered, so a
 * too-broad pattern (e.g. /a/) keeps the most common forms; kwicTotal counts
 * only these keys too, so page counts stay consistent with the results. */
export const REGEX_KEY_CAP = 1000;

function likeEscape(q: string): string {
  return q.replace(/[\\%_]/g, (c) => "\\" + c);
}

/** Per-db memo (request-scoped in production; bounded for long-lived dev dbs). */
const memo = new WeakMap<object, Map<string, Promise<string[]>>>();

/**
 * Resolve a word regex to the distinct corpus keys it matches, most frequent
 * first, capped at REGEX_KEY_CAP. Throws BadRegexError on an invalid pattern.
 */
export async function regexNodeKeys(
  db: D1Database,
  source: string,
  keyCol: "surface_fold" | "surface_norm",
): Promise<string[]> {
  let byPattern = memo.get(db as object);
  if (!byPattern) memo.set(db as object, (byPattern = new Map()));
  const memoKey = `${keyCol}\u0000${source}`;
  const hit = byPattern.get(memoKey);
  if (hit) return hit;
  if (byPattern.size >= 32) byPattern.clear();
  const p = resolveKeys(db, source, keyCol);
  byPattern.set(memoKey, p);
  // Don't cache failures (invalid regex, pre-Phase-5 schema without the fold
  // column) — the fold→norm fallback retries under a different memo key anyway.
  p.catch(() => byPattern.delete(memoKey));
  return p;
}

async function resolveKeys(
  db: D1Database,
  source: string,
  keyCol: "surface_fold" | "surface_norm",
): Promise<string[]> {
  const re = compileWordRegex(source);
  const params: unknown[] = [];
  let where = "";
  const lit = requiredLiteral(source);
  if (lit) {
    // Stored keys are lowercase; the fold column is also accent/apostrophe-free.
    let litKey = lit.toLocaleLowerCase("en");
    if (keyCol === "surface_fold") litKey = foldAccents(litKey);
    if (litKey) {
      where = `WHERE ${keyCol} LIKE ? ESCAPE '\\' `;
      params.push("%" + likeEscape(litKey) + "%");
    }
  }
  const { results } = await db
    .prepare(`SELECT ${keyCol} AS k, count(*) AS c FROM corpus_tokens ${where}GROUP BY k ORDER BY c DESC`)
    .bind(...params)
    .all<{ k: string; c: number }>();
  const keys: string[] = [];
  for (const r of results ?? []) {
    if (r.k && re.test(String(r.k))) {
      keys.push(String(r.k));
      if (keys.length >= REGEX_KEY_CAP) break;
    }
  }
  return keys;
}
