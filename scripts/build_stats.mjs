#!/usr/bin/env bun
/**
 * Build public/stats.json — the precomputed dataset behind the /stats page.
 *
 * Reads build/corpus.db (see load_tokens.mjs) and data/collection_registers.json,
 * streams the token layer once, and writes:
 *   - corpus totals (tokens, sentences, types, hapax, documents, tagged share)
 *   - per-register token/sentence/type counts, top words (function-flagged),
 *     top bigrams/trigrams, POS composition, sentence-length histogram
 *   - per-register keywords (log-likelihood G² vs the rest of the corpus)
 *   - dialect distribution grouped by region
 *   - Zipf rank–frequency series
 *   - per-collection table
 *
 * Word-level stats cover Latin-script tokens; n-grams follow the token layer's
 * adjacency (consecutive idx within one sentence), matching /v1/freq/ngram.
 *
 *   bun scripts/build_stats.mjs [--db=build/corpus.db] [--out=public/stats.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const pathArg = (name, fallback) => {
  const v = arg(name);
  return v ? resolve(process.cwd(), v) : new URL(fallback, import.meta.url).pathname;
};
const DB_PATH = pathArg("db", "../build/corpus.db");
const OUT = pathArg("out", "../public/stats.json");
const REGISTERS_PATH = new URL("../data/collection_registers.json", import.meta.url).pathname;

const { registers, collections: collectionRegister } = JSON.parse(readFileSync(REGISTERS_PATH, "utf8"));
const REG_IDS = Object.keys(registers); // 8 registers
const ALL = REG_IDS.length; // extra slot for the whole corpus
const regIndex = new Map(REG_IDS.map((id, i) => [id, i]));

const FUNCTION_UPOS = new Set(["ADP", "AUX", "CCONJ", "DET", "PART", "PRON", "SCONJ", "PUNCT"]);
const TOP_WORDS = 60;
const TOP_NGRAMS = 30;
const TOP_KEYWORDS = 20;
const ZIPF_RANKS = 1000;
const LEN_BINS = 30; // sentence-length histogram: 1..30 tokens, then 31+

const db = new Database(DB_PATH, { readonly: true });

// ---- sentences: register lookup, dialect + collection tallies -------------
const sentenceReg = new Map();
const sentenceColl = new Map();
const regSentences = new Array(ALL + 1).fill(0);
const dialectByRegion = new Map(); // region -> Map(dialect -> n)
const collectionStats = new Map(); // collection -> {register, sentences, words, types:Set, lenSum, lenN}
for (const row of db.query("SELECT id, collection, dialect, region FROM sentences").all()) {
  const regId = collectionRegister[row.collection ?? ""] ?? "other";
  const ri = regIndex.get(regId);
  sentenceReg.set(row.id, ri);
  regSentences[ri]++;
  regSentences[ALL]++;
  const region = row.region || "unspecified";
  if (!dialectByRegion.has(region)) dialectByRegion.set(region, new Map());
  const dmap = dialectByRegion.get(region);
  const dialect = row.dialect || "unspecified";
  dmap.set(dialect, (dmap.get(dialect) ?? 0) + 1);
  const cname = row.collection || "（無題）";
  sentenceColl.set(row.id, cname);
  if (!collectionStats.has(cname)) {
    collectionStats.set(cname, { register: regId, sentences: 0, words: 0, types: new Set(), lenSum: 0, lenN: 0 });
  }
  collectionStats.get(cname).sentences++;
}

// ---- token stream: words, n-grams, POS, sentence lengths ------------------
/** fold -> {regs: Uint32Array, surf: Map(norm->n), upos: Map(upos->n), clitic: n} */
const words = new Map();
/** "norm norm" -> Uint32Array(ALL+1) */
const bigrams = new Map();
const trigrams = new Map();
const posByReg = Array.from({ length: ALL + 1 }, () => new Map());
const untaggedByReg = new Array(ALL + 1).fill(0);
const tokensByReg = new Array(ALL + 1).fill(0); // all scripts
const latnByReg = new Array(ALL + 1).fill(0);
const sentenceLen = new Map(); // sid -> word tokens (latn+kana)

const bump = (map, key) => {
  let counts = map.get(key);
  if (!counts) map.set(key, (counts = new Uint32Array(ALL + 1)));
  return counts;
};

let cursorSid = "";
let cursorIdx = -1;
let prev = null; // {sid, idx, norm}
let prev2 = null;
const page = db.query(`
  SELECT sentence_id sid, idx, surface_norm norm, surface_fold fold, script, is_clitic clitic, upos
  FROM corpus_tokens
  WHERE (sentence_id, idx) > (?, ?)
  ORDER BY sentence_id, idx
  LIMIT 200000
`);
for (;;) {
  const rows = page.all(cursorSid, cursorIdx);
  if (rows.length === 0) break;
  for (const t of rows) {
    const ri = sentenceReg.get(t.sid);
    if (ri === undefined) continue;
    tokensByReg[ri]++;
    tokensByReg[ALL]++;
    if (t.upos) {
      const pm = posByReg[ri];
      pm.set(t.upos, (pm.get(t.upos) ?? 0) + 1);
      const pa = posByReg[ALL];
      pa.set(t.upos, (pa.get(t.upos) ?? 0) + 1);
    } else {
      untaggedByReg[ri]++;
      untaggedByReg[ALL]++;
    }
    if (t.script === "latn" || t.script === "kana") {
      sentenceLen.set(t.sid, (sentenceLen.get(t.sid) ?? 0) + 1);
    }
    if (t.script !== "latn") continue;
    latnByReg[ri]++;
    latnByReg[ALL]++;
    let w = words.get(t.fold);
    if (!w) words.set(t.fold, (w = { regs: new Uint32Array(ALL + 1), surf: new Map(), upos: new Map(), clitic: 0 }));
    w.regs[ri]++;
    w.regs[ALL]++;
    w.surf.set(t.norm, (w.surf.get(t.norm) ?? 0) + 1);
    if (t.upos) w.upos.set(t.upos, (w.upos.get(t.upos) ?? 0) + 1);
    if (t.clitic) w.clitic++;
    if (prev && prev.sid === t.sid && prev.idx === t.idx - 1) {
      const bg = bump(bigrams, `${prev.norm} ${t.norm}`);
      bg[ri]++;
      bg[ALL]++;
      if (prev2 && prev2.sid === t.sid && prev2.idx === t.idx - 2) {
        const tg = bump(trigrams, `${prev2.norm} ${prev.norm} ${t.norm}`);
        tg[ri]++;
        tg[ALL]++;
      }
    }
    prev2 = prev;
    prev = { sid: t.sid, idx: t.idx, norm: t.norm };
  }
  const last = rows[rows.length - 1];
  cursorSid = last.sid;
  cursorIdx = last.idx;
}

// per-collection token/type counts need collection per token: one more cheap pass
const collPage = db.query(`
  SELECT t.surface_fold fold, s.collection coll, COUNT(*) n
  FROM corpus_tokens t JOIN sentences s ON s.id = t.sentence_id
  WHERE t.script = 'latn'
  GROUP BY s.collection, t.surface_fold
`);
for (const row of collPage.all()) {
  const c = collectionStats.get(row.coll || "（無題）");
  if (!c) continue;
  c.words += row.n;
  c.types.add(row.fold);
}
// sentence lengths per collection, on the same latn+kana basis as the registers
for (const [sid, len] of sentenceLen) {
  const c = collectionStats.get(sentenceColl.get(sid));
  if (!c) continue;
  c.lenSum += len;
  c.lenN++;
}

// ---- sentence-length histograms per register ------------------------------
const lenHist = Array.from({ length: ALL + 1 }, () => new Uint32Array(LEN_BINS + 1));
const lenLists = Array.from({ length: ALL + 1 }, () => []);
for (const [sid, len] of sentenceLen) {
  const ri = sentenceReg.get(sid);
  const bin = Math.min(len, LEN_BINS + 1) - 1;
  lenHist[ri][bin]++;
  lenHist[ALL][bin]++;
  lenLists[ri].push(len);
  lenLists[ALL].push(len);
}
const median = (xs) => {
  if (xs.length === 0) return 0;
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)];
};
const mean = (xs) => (xs.length === 0 ? 0 : Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10);

// ---- derive word-level outputs --------------------------------------------
const display = (w) => [...w.surf.entries()].sort((a, b) => b[1] - a[1])[0][0];
const isFunction = (w) => {
  const total = w.regs[ALL];
  if (w.clitic / total > 0.5) return true;
  let tagged = 0;
  let closed = 0;
  for (const [u, n] of w.upos) {
    tagged += n;
    if (FUNCTION_UPOS.has(u)) closed += n;
  }
  return tagged > 0 && closed / tagged > 0.5;
};

const wordList = [...words.entries()].map(([fold, w]) => ({ fold, w }));
wordList.sort((a, b) => b.w.regs[ALL] - a.w.regs[ALL]);
const hapax = wordList.reduce((n, e) => n + (e.w.regs[ALL] === 1 ? 1 : 0), 0);

const topWords = {};
const keywords = {};
const contentKeywords = {}; // register id -> scored content entries, for sample picking
for (let ri = 0; ri <= ALL; ri++) {
  const key = ri === ALL ? "all" : REG_IDS[ri];
  const N1 = latnByReg[ri];
  topWords[key] = wordList
    .filter((e) => e.w.regs[ri] > 0)
    .sort((a, b) => b.w.regs[ri] - a.w.regs[ri])
    .slice(0, TOP_WORDS)
    .map((e) => ({
      w: display(e.w),
      n: e.w.regs[ri],
      pm: Math.round((e.w.regs[ri] / N1) * 1e6),
      ...(isFunction(e.w) && { f: 1 }),
    }));
  if (ri === ALL) continue;
  const N = latnByReg[ALL];
  const N2 = N - N1;
  if (N1 === 0 || N2 === 0) {
    keywords[key] = [];
    continue;
  }
  const scored = [];
  for (const e of wordList) {
    const a = e.w.regs[ri];
    const total = e.w.regs[ALL];
    if (total < 20 || a < 5) continue;
    // bare letters (speaker labels, list markers) and punctuation-bearing tokens
    if (/^[a-z]$|[.,!?。、「」()（）]/.test(display(e.w))) continue;
    const b = total - a;
    if (a / N1 <= total / N) continue; // overuse only
    const e1 = (N1 * total) / N;
    const e2 = (N2 * total) / N;
    const g2 = 2 * ((a > 0 ? a * Math.log(a / e1) : 0) + (b > 0 ? b * Math.log(b / e2) : 0));
    scored.push({ e, a, b, g2 });
  }
  scored.sort((x, y) => y.g2 - x.g2);
  const content = scored.filter((s) => !isFunction(s.e.w)).slice(0, TOP_KEYWORDS);
  const grammatical = scored.filter((s) => isFunction(s.e.w)).slice(0, TOP_KEYWORDS);
  contentKeywords[key] = content;
  keywords[key] = [...content, ...grammatical]
    .sort((x, y) => y.g2 - x.g2)
    .map(({ e, a, b, g2 }) => ({
      w: display(e.w),
      n: a,
      g2: Math.round(g2 * 10) / 10,
      pm: Math.round((a / N1) * 1e6),
      pmRest: Math.round((b / N2) * 1e6),
      ...(isFunction(e.w) && { f: 1 }),
    }));
}

// ---- sample sentences: two per register, each showing a keyword in use ------
const sentenceById = db.query("SELECT text, translation, collection FROM sentences WHERE id = ?");
const sentencesWithWord = db.query("SELECT DISTINCT sentence_id sid FROM corpus_tokens WHERE surface_norm = ? AND script = 'latn' LIMIT 500");
const samples = [];
for (let ri = 0; ri < ALL; ri++) {
  const id = REG_IDS[ri];
  const pool = contentKeywords[id] ?? [];
  const used = new Set();
  for (const { e } of pool) {
    if (used.size >= 2) break;
    const focus = display(e.w);
    const hit = sentencesWithWord
      .all(focus)
      .filter((r) => sentenceReg.get(r.sid) === ri && !used.has(r.sid))
      .map((r) => ({ sid: r.sid, len: sentenceLen.get(r.sid) ?? 0 }))
      .filter((r) => r.len >= 8 && r.len <= 25)
      .sort((a, b) => a.len - b.len || (a.sid < b.sid ? -1 : 1))[0];
    if (!hit) continue;
    const s = sentenceById.get(hit.sid);
    if (!s || /^[A-ZＡ-Ｚa-z][:：]/.test(s.text)) continue;
    used.add(hit.sid);
    samples.push({
      register: id,
      text: s.text,
      ...(s.translation && { translation: s.translation }),
      collection: s.collection || "（無題）",
      focus,
    });
  }
}

const topGrams = (map, ri) =>
  [...map.entries()]
    .filter(([, counts]) => counts[ri] > 0)
    .sort((a, b) => b[1][ri] - a[1][ri])
    .slice(0, TOP_NGRAMS)
    .map(([g, counts]) => ({ g, n: counts[ri] }));

const perRegister = {};
for (let ri = 0; ri < ALL; ri++) {
  const id = REG_IDS[ri];
  let types = 0;
  for (const e of wordList) if (e.w.regs[ri] > 0) types++;
  perRegister[id] = {
    label: registers[id].label,
    ja: registers[id].ja,
    description: registers[id].description,
    sentences: regSentences[ri],
    tokens: tokensByReg[ri],
    words: latnByReg[ri],
    types,
    pos: Object.fromEntries([...posByReg[ri].entries()].sort((a, b) => b[1] - a[1])),
    untagged: untaggedByReg[ri],
    lengthHist: [...lenHist[ri]],
    medianLength: median(lenLists[ri]),
    meanLength: mean(lenLists[ri]),
    topWords: topWords[id],
    keywords: keywords[id],
    bigrams: topGrams(bigrams, ri),
    trigrams: topGrams(trigrams, ri),
  };
}

const zipf = wordList.slice(0, ZIPF_RANKS).map((e, i) => ({ r: i + 1, n: e.w.regs[ALL], w: display(e.w) }));

const dialects = [...dialectByRegion.entries()].map(([region, dmap]) => {
  const entries = [...dmap.entries()].sort((a, b) => b[1] - a[1]);
  const top = entries.slice(0, 12).map(([name, n]) => ({ name, n }));
  const rest = entries.slice(12).reduce((s, [, n]) => s + n, 0);
  if (rest > 0) top.push({ name: "（その他）", n: rest });
  return { region, sentences: entries.reduce((s, [, n]) => s + n, 0), dialects: top };
}).sort((a, b) => b.sentences - a.sentences);

const collectionDialect = new Map();
for (const row of db
  .query("SELECT collection, dialect, COUNT(*) n FROM sentences WHERE dialect != '' GROUP BY collection, dialect ORDER BY n")
  .all()) {
  collectionDialect.set(row.collection || "（無題）", row.dialect); // last row per collection = most frequent
}

const collectionsOut = [...collectionStats.entries()]
  .map(([name, c]) => ({
    name,
    register: c.register,
    dialect: collectionDialect.get(name) ?? null,
    sentences: c.sentences,
    words: c.words,
    types: c.types.size,
    meanLength: c.lenN ? Math.round((c.lenSum / c.lenN) * 10) / 10 : 0,
  }))
  .sort((a, b) => b.sentences - a.sentences);

const stats = {
  generated: new Date().toISOString().slice(0, 10),
  totals: {
    tokens: tokensByReg[ALL],
    words: latnByReg[ALL],
    sentences: regSentences[ALL],
    types: words.size,
    hapax,
    documents: db.query("SELECT COUNT(DISTINCT document) n FROM sentences").get().n,
    collections: collectionStats.size,
    tagged: tokensByReg[ALL] - untaggedByReg[ALL],
    lengthHist: [...lenHist[ALL]],
    medianLength: median(lenLists[ALL]),
    meanLength: mean(lenLists[ALL]),
    pos: Object.fromEntries([...posByReg[ALL].entries()].sort((a, b) => b[1] - a[1])),
    untagged: untaggedByReg[ALL],
  },
  registers: perRegister,
  topWords: topWords.all,
  bigrams: topGrams(bigrams, ALL),
  trigrams: topGrams(trigrams, ALL),
  zipf,
  dialects,
  collections: collectionsOut,
  samples,
};

const payload = JSON.stringify(stats);
writeFileSync(OUT, payload);
const kb = Math.round(Buffer.byteLength(payload) / 1024);
console.log(`wrote ${OUT} (${kb} KB): ${words.size} types, ${bigrams.size} bigrams, ${trigrams.size} trigrams`);
