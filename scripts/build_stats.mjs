#!/usr/bin/env bun
/**
 * Build public/stats.json and its filtered slices — the precomputed datasets
 * behind the /stats page.
 *
 * Reads build/corpus.db (see load_tokens.mjs) and data/collection_registers.json,
 * streams the token layer, and writes for the whole corpus and for each slice
 * (Hokkaidō / Sakhalin by sentence region record; traditional / modern by
 * collection era):
 *   - totals (tokens, sentences, types, hapax, documents, tagged share)
 *   - per-register token/sentence/type counts, top words (function-flagged),
 *     top bigrams/trigrams, POS composition, sentence-length histogram
 *   - per-register keywords (log-likelihood G² vs the rest of the slice)
 *   - dialect distribution grouped by region
 *   - Zipf rank–frequency series, sample sentences, per-collection table
 * Slice files add `slice` metadata and `sliceKeywords` (G² of the slice
 * against the rest of the corpus).
 *
 * Word-level stats cover Latin-script tokens; n-grams follow the token layer's
 * adjacency (consecutive idx within one sentence), matching /v1/freq/ngram.
 *
 *   bun scripts/build_stats.mjs [--db=build/corpus.db] [--outdir=public]
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
const OUT_DIR = pathArg("outdir", "../public");
const REGISTERS_PATH = new URL("../data/collection_registers.json", import.meta.url).pathname;

const {
  registers,
  collections: collectionRegister,
  eras: eraMeta,
  collectionEras,
} = JSON.parse(readFileSync(REGISTERS_PATH, "utf8"));
const REG_IDS = Object.keys(registers); // 8 registers
const ALL = REG_IDS.length; // extra slot for the whole selection
const regIndex = new Map(REG_IDS.map((id, i) => [id, i]));

const FUNCTION_UPOS = new Set(["ADP", "AUX", "CCONJ", "DET", "PART", "PRON", "SCONJ", "PUNCT"]);
const TOP_WORDS = 60;
const TOP_NGRAMS = 30;
const TOP_KEYWORDS = 20;
const G2_FLOOR = 10.83; // chi-square 1 df at p < 0.001: below this a "keyword" is noise
const ZIPF_RANKS = 1000;
const LEN_BINS = 30; // sentence-length histogram: 1..30 tokens, then 31+
const KEY_SKIP = /^[a-zA-Z]$|[.,!?。、「」()（）_]/; // speaker labels, list markers, punctuation, notation

const SLICES = [
  { id: "hokkaido", label: "Hokkaidō", ja: "北海道", region: "北海道",
    basis: "sentences whose source metadata records a Hokkaidō dialect" },
  { id: "sakhalin", label: "Sakhalin", ja: "樺太", region: "樺太",
    basis: "sentences whose source metadata records a Sakhalin dialect" },
  { id: "traditional", label: eraMeta.traditional.label, ja: eraMeta.traditional.ja, era: "traditional",
    basis: eraMeta.traditional.description },
  { id: "modern", label: eraMeta.modern.label, ja: eraMeta.modern.ja, era: "modern",
    basis: eraMeta.modern.description },
];

const db = new Database(DB_PATH, { readonly: true });
const generated = new Date().toISOString().slice(0, 10);

const median = (xs) => {
  if (xs.length === 0) return 0;
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)];
};
const mean = (xs) => (xs.length === 0 ? 0 : Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10);
const display = (w) => [...w.surf.entries()].sort((a, b) => b[1] - a[1])[0][0];
const isFunction = (w) => {
  const total = w.total;
  if (w.clitic / total > 0.5) return true;
  let tagged = 0;
  let closed = 0;
  for (const [u, n] of w.upos) {
    tagged += n;
    if (FUNCTION_UPOS.has(u)) closed += n;
  }
  return tagged > 0 && closed / tagged > 0.5;
};
// Dunning (1993) log-likelihood over the full 2×2 table; overuse only, floored.
const g2Score = (a, b, N1, N2) => {
  const N = N1 + N2;
  const total = a + b;
  if (a / N1 <= total / N) return 0;
  const c2 = N1 - a;
  const d2 = N2 - b;
  const term = (o, ex) => (o > 0 ? o * Math.log(o / ex) : 0);
  return 2 * (term(a, (N1 * total) / N) + term(b, (N2 * total) / N) +
    term(c2, (N1 * (c2 + d2)) / N) + term(d2, (N2 * (c2 + d2)) / N));
};

const sentenceById = db.query("SELECT text, translation, collection, document FROM sentences WHERE id = ?");
const sentencesWithWord = db.query(
  "SELECT DISTINCT sentence_id sid FROM corpus_tokens WHERE surface_fold = ? AND script = 'latn' ORDER BY sentence_id LIMIT 5000",
);
const surfaceInSentence = db.query(
  "SELECT surface FROM corpus_tokens WHERE sentence_id = ? AND surface_fold = ? LIMIT 1",
);
const speakerLabel = /^[^\s：:]{1,10}[:：]/;

/**
 * Compute the full dataset for a selection of sentences.
 * slice: null for the whole corpus, else {region} or {era}.
 */
function buildStats(slice, { warn = false } = {}) {
  const inSlice = (cname, region) => {
    if (!slice) return true;
    if (slice.region) return region === slice.region;
    return (collectionEras[cname] ?? null) === slice.era;
  };

  // ---- sentences: register lookup, dialect + collection tallies -----------
  const sentenceReg = new Map();
  const sentenceColl = new Map();
  const regSentences = new Array(ALL + 1).fill(0);
  const dialectByRegion = new Map(); // region -> Map(dialect -> n)
  const collectionStats = new Map();
  const docSet = new Set();
  const unmapped = new Map();
  for (const row of db.query("SELECT id, collection, dialect, region, document FROM sentences").all()) {
    // Single-document sources can arrive with an empty collection and the
    // collection title in `document`; fall back so they keep their register.
    const cname = row.collection || row.document || "（無題）";
    if (!(cname in collectionRegister)) unmapped.set(cname, (unmapped.get(cname) ?? 0) + 1);
    if (!inSlice(cname, row.region || "")) continue;
    const regId = collectionRegister[cname] ?? "other";
    const ri = regIndex.get(regId);
    sentenceReg.set(row.id, ri);
    regSentences[ri]++;
    regSentences[ALL]++;
    docSet.add(row.document || "");
    const region = row.region || "unspecified";
    if (!dialectByRegion.has(region)) dialectByRegion.set(region, new Map());
    const dmap = dialectByRegion.get(region);
    const dialect = row.dialect || "unspecified";
    dmap.set(dialect, (dmap.get(dialect) ?? 0) + 1);
    sentenceColl.set(row.id, cname);
    if (!collectionStats.has(cname)) {
      collectionStats.set(cname, { register: regId, sentences: 0, words: 0, types: new Set(), lenSum: 0, lenN: 0 });
    }
    collectionStats.get(cname).sentences++;
  }
  if (warn) {
    for (const [name, n] of unmapped) console.warn(`unmapped collection → "other": ${name} (${n} sentences)`);
    for (const name of Object.keys(collectionRegister)) {
      if (!collectionStats.has(name)) console.warn(`mapped collection absent from the corpus: ${name}`);
    }
  }

  // ---- token stream: words, n-grams, POS, sentence lengths ----------------
  /** fold -> {regs: Uint32Array, total, surf: Map(surface->n), upos: Map, clitic} */
  const words = new Map();
  const bigrams = new Map();
  const trigrams = new Map();
  const posByReg = Array.from({ length: ALL + 1 }, () => new Map());
  const untaggedByReg = new Array(ALL + 1).fill(0);
  const tokensByReg = new Array(ALL + 1).fill(0);
  const latnByReg = new Array(ALL + 1).fill(0);
  const sentenceLen = new Map();

  const bump = (map, key) => {
    let counts = map.get(key);
    if (!counts) map.set(key, (counts = new Uint32Array(ALL + 1)));
    return counts;
  };

  let cursorSid = "";
  let cursorIdx = -1;
  let prev = null;
  let prev2 = null;
  const pageQ = db.query(`
    SELECT sentence_id sid, idx, surface, surface_fold fold, script, is_clitic clitic, upos
    FROM corpus_tokens
    WHERE (sentence_id, idx) > (?, ?)
    ORDER BY sentence_id, idx
    LIMIT 200000
  `);
  for (;;) {
    const rows = pageQ.all(cursorSid, cursorIdx);
    if (rows.length === 0) break;
    for (const t of rows) {
      const ri = sentenceReg.get(t.sid);
      if (ri === undefined) continue;
      tokensByReg[ri]++;
      tokensByReg[ALL]++;
      if (t.upos) {
        posByReg[ri].set(t.upos, (posByReg[ri].get(t.upos) ?? 0) + 1);
        posByReg[ALL].set(t.upos, (posByReg[ALL].get(t.upos) ?? 0) + 1);
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
      if (!w) words.set(t.fold, (w = { regs: new Uint32Array(ALL + 1), total: 0, surf: new Map(), upos: new Map(), clitic: 0 }));
      w.regs[ri]++;
      w.regs[ALL]++;
      w.total++;
      w.surf.set(t.surface, (w.surf.get(t.surface) ?? 0) + 1);
      if (t.upos) w.upos.set(t.upos, (w.upos.get(t.upos) ?? 0) + 1);
      if (t.clitic) w.clitic++;
      if (prev && prev.sid === t.sid && prev.idx === t.idx - 1) {
        const bg = bump(bigrams, `${prev.fold} ${t.fold}`);
        bg[ri]++;
        bg[ALL]++;
        if (prev2 && prev2.sid === t.sid && prev2.idx === t.idx - 2) {
          const tg = bump(trigrams, `${prev2.fold} ${prev.fold} ${t.fold}`);
          tg[ri]++;
          tg[ALL]++;
        }
      }
      prev2 = prev;
      prev = { sid: t.sid, idx: t.idx, fold: t.fold };
    }
    const last = rows[rows.length - 1];
    cursorSid = last.sid;
    cursorIdx = last.idx;
  }

  // per-collection token/type counts: one aggregate pass, filtered like the rest
  const regionCond = slice?.region ? "AND s.region = ?" : "";
  const collPage = db.query(`
    SELECT t.surface_fold fold, COALESCE(NULLIF(s.collection, ''), NULLIF(s.document, ''), '（無題）') coll, COUNT(*) n
    FROM corpus_tokens t JOIN sentences s ON s.id = t.sentence_id
    WHERE t.script = 'latn' ${regionCond}
    GROUP BY coll, t.surface_fold
  `);
  for (const row of slice?.region ? collPage.all(slice.region) : collPage.all()) {
    const c = collectionStats.get(row.coll);
    if (!c) continue;
    c.words += row.n;
    c.types.add(row.fold);
  }
  for (const [sid, len] of sentenceLen) {
    const c = collectionStats.get(sentenceColl.get(sid));
    if (!c) continue;
    c.lenSum += len;
    c.lenN++;
  }

  // ---- sentence-length histograms per register ----------------------------
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

  // ---- derive word-level outputs ------------------------------------------
  const wordList = [...words.entries()].map(([fold, w]) => ({ fold, w }));
  wordList.sort((a, b) => b.w.regs[ALL] - a.w.regs[ALL]);
  const hapax = wordList.reduce((n, e) => n + (e.w.regs[ALL] === 1 ? 1 : 0), 0);

  const topWords = {};
  const keywords = {};
  const contentKeywords = {};
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
      contentKeywords[key] = [];
      continue;
    }
    const scored = [];
    for (const e of wordList) {
      const a = e.w.regs[ri];
      const total = e.w.regs[ALL];
      if (total < 20 || a < 5) continue;
      if (KEY_SKIP.test(display(e.w))) continue;
      const b = total - a;
      const g2 = g2Score(a, b, N1, N2);
      if (g2 < G2_FLOOR) continue;
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

  // ---- sample sentences: two per register, each showing a keyword in use ---
  const samples = [];
  for (let ri = 0; ri < ALL; ri++) {
    const id = REG_IDS[ri];
    const pool = contentKeywords[id] ?? [];
    const used = new Set();
    for (const { e } of pool) {
      if (used.size >= 2) break;
      const focus = display(e.w);
      const candidates = sentencesWithWord
        .all(e.fold)
        .filter((r) => sentenceReg.get(r.sid) === ri && !used.has(r.sid))
        .map((r) => ({ sid: r.sid, len: sentenceLen.get(r.sid) ?? 0 }))
        .filter((r) => r.len >= 8 && r.len <= 25)
        .sort((a, b) => a.len - b.len || (a.sid < b.sid ? -1 : 1));
      let picked = null;
      for (const cand of candidates) {
        const s = sentenceById.get(cand.sid);
        if (!s) continue;
        if (speakerLabel.test(s.text) || (s.translation && speakerLabel.test(s.translation))) continue;
        if (/[-‐]$/.test(s.text.trim())) continue; // line-continuation fragments
        if (!picked || (!picked.s.translation && s.translation)) picked = { sid: cand.sid, s };
        if (picked.s.translation) break;
      }
      if (!picked) continue;
      used.add(picked.sid);
      samples.push({
        register: id,
        text: picked.s.text,
        ...(picked.s.translation && { translation: picked.s.translation }),
        collection: picked.s.collection || picked.s.document || "（無題）",
        // the word as spelled in this sentence, so the page highlight matches
        focus: surfaceInSentence.get(picked.sid, e.fold)?.surface ?? focus,
      });
    }
  }

  // grams are keyed on folded forms (matching /v1/freq/ngram); display each
  // word in its commonest spelling within the selection
  const displayByFold = new Map();
  const gramDisplay = (foldKey) =>
    foldKey
      .split(" ")
      .map((f) => {
        if (!displayByFold.has(f)) {
          const w = words.get(f);
          displayByFold.set(f, w ? display(w) : f);
        }
        return displayByFold.get(f);
      })
      .join(" ");
  const topGrams = (map, ri) =>
    [...map.entries()]
      .filter(([, counts]) => counts[ri] > 0)
      .sort((a, b) => b[1][ri] - a[1][ri])
      .slice(0, TOP_NGRAMS)
      .map(([g, counts]) => ({ g: gramDisplay(g), n: counts[ri] }));

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
      sentencesWithWords: lenLists[ri].length,
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

  const dialects = [...dialectByRegion.entries()]
    .map(([region, dmap]) => {
      const entries = [...dmap.entries()].sort((a, b) => b[1] - a[1]);
      const top = entries.slice(0, 12).map(([name, n]) => ({ name, n }));
      const rest = entries.slice(12).reduce((s, [, n]) => s + n, 0);
      if (rest > 0) top.push({ name: "（その他）", n: rest });
      return { region, sentences: entries.reduce((s, [, n]) => s + n, 0), dialects: top };
    })
    .sort((a, b) => b.sentences - a.sentences);

  const dialCond = slice?.region ? "AND region = ?" : "";
  const collDial = db.query(`SELECT COALESCE(NULLIF(collection, ''), NULLIF(document, ''), '（無題）') coll, dialect, COUNT(*) n
    FROM sentences WHERE dialect != '' ${dialCond} GROUP BY coll, dialect`);
  const collectionDialect = new Map();
  for (const row of slice?.region ? collDial.all(slice.region) : collDial.all()) {
    const cur = collectionDialect.get(row.coll);
    if (!cur || row.n > cur.n) collectionDialect.set(row.coll, { dialect: row.dialect, n: row.n });
  }

  const collectionsOut = [...collectionStats.entries()]
    .map(([name, c]) => ({
      name,
      register: c.register,
      dialect: collectionDialect.get(name)?.dialect ?? null,
      sentences: c.sentences,
      words: c.words,
      types: c.types.size,
      meanLength: c.lenN ? Math.round((c.lenSum / c.lenN) * 10) / 10 : 0,
    }))
    .sort((a, b) => b.sentences - a.sentences);

  const stats = {
    generated,
    totals: {
      tokens: tokensByReg[ALL],
      words: latnByReg[ALL],
      sentences: regSentences[ALL],
      types: words.size,
      hapax,
      documents: docSet.size,
      collections: collectionStats.size,
      tagged: tokensByReg[ALL] - untaggedByReg[ALL],
      sentencesWithWords: lenLists[ALL].length,
      lengthHist: [...lenHist[ALL]],
      medianLength: median(lenLists[ALL]),
      meanLength: mean(lenLists[ALL]),
      pos: Object.fromEntries([...posByReg[ALL].entries()].sort((a, b) => b[1] - a[1])),
      untagged: untaggedByReg[ALL],
    },
    registers: perRegister,
    zipf,
    dialects,
    collections: collectionsOut,
    samples,
  };
  return { stats, words, latnTotal: latnByReg[ALL] };
}

// slice vs the whole corpus: which words the slice reaches for
function sliceKeywords(sliceWords, sliceLatn, allWords, allLatn) {
  const N1 = sliceLatn;
  const N2 = allLatn - sliceLatn;
  if (N1 === 0 || N2 === 0) return [];
  const scored = [];
  for (const [fold, w] of sliceWords) {
    const a = w.total;
    const total = allWords.get(fold)?.total ?? a;
    if (total < 20 || a < 5) continue;
    if (KEY_SKIP.test(display(w))) continue;
    const b = total - a;
    const g2 = g2Score(a, b, N1, N2);
    if (g2 < G2_FLOOR) continue;
    scored.push({ w, a, b, g2 });
  }
  scored.sort((x, y) => y.g2 - x.g2);
  const content = scored.filter((s) => !isFunction(s.w)).slice(0, TOP_KEYWORDS);
  const grammatical = scored.filter((s) => isFunction(s.w)).slice(0, TOP_KEYWORDS);
  return [...content, ...grammatical]
    .sort((x, y) => y.g2 - x.g2)
    .map(({ w, a, b, g2 }) => ({
      w: display(w),
      n: a,
      g2: Math.round(g2 * 10) / 10,
      pm: Math.round((a / N1) * 1e6),
      pmRest: Math.round((b / N2) * 1e6),
      ...(isFunction(w) && { f: 1 }),
    }));
}

const write = (name, obj) => {
  const payload = JSON.stringify(obj);
  writeFileSync(resolve(OUT_DIR, name), payload);
  console.log(`wrote ${name} (${Math.round(Buffer.byteLength(payload) / 1024)} KB)`);
};

const all = buildStats(null, { warn: true });
const sliceSummaries = [];
for (const slice of SLICES) {
  const s = buildStats(slice);
  s.stats.slice = { id: slice.id, label: slice.label, ja: slice.ja, basis: slice.basis };
  s.stats.sliceKeywords = sliceKeywords(s.words, s.latnTotal, all.words, all.latnTotal);
  sliceSummaries.push({ id: slice.id, label: slice.label, ja: slice.ja, basis: slice.basis,
    sentences: s.stats.totals.sentences, words: s.stats.totals.words });
  write(`stats-${slice.id}.json`, s.stats);
}
all.stats.slices = sliceSummaries;
write("stats.json", all.stats);
