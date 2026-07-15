#!/usr/bin/env bun
/**
 * Serve the UI against a LOCAL bun:sqlite copy of the corpus (build/corpus.db)
 * mounting the real Hono app, and screenshot the one-box UI: empty state,
 * every auto-detected query kind (word/gloss, filter, pattern, text) and every
 * word view (collocates, distribution, forms) in light & dark for visual review.
 * Outputs build/ui-*.png. Requires build/corpus.db (see load_tokens.mjs).
 *
 *   bun scripts/shoot.mjs
 */
import { chromium } from "playwright";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import app from "../src/index.ts";

const DB = new URL("../build/corpus.db", import.meta.url).pathname;
const ROOT = new URL("../public/", import.meta.url).pathname;
mkdirSync(new URL("../build/", import.meta.url).pathname, { recursive: true });

const sq = new Database(DB, { readonly: true });
const d1 = {
  prepare(sql) {
    let args = [];
    const stmt = {
      bind(...a) { args = a; return stmt; },
      async all() { return { results: sq.query(sql).all(...args) }; },
      async first() { return sq.query(sql).get(...args) ?? null; },
    };
    return stmt;
  },
};
const env = { API_VERSION: "1", DATABASE_URL: "x", DATABASE_AUTH_TOKEN: "x", __TEST_DB__: d1 };

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname.endsWith(".html")) {
      const p = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      return new Response(Bun.file(ROOT + p), { headers: { "content-type": "text/html" } });
    }
    return app.fetch(req, env);
  },
});
const base = `http://localhost:${server.port}`;
const browser = await chromium.launch();

async function shoot(name, scheme, fn) {
  const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1240, height: 900 }, deviceScaleFactor: 1.5 });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: "networkidle" });
  await fn(page);
  await page.waitForTimeout(700);
  await page.screenshot({ path: new URL(`../build/${name}.png`, import.meta.url).pathname });
  console.log(name, "ok");
  await ctx.close();
}

const search = async (p, q) => { await p.fill("#q", q); await p.click("button.go"); };
const tab = (p, v) => p.click(`#tabs button[data-view="${v}"]`);

await shoot("ui-empty", "light", async () => {});
await shoot("ui-empty-dark", "dark", async () => {});
await shoot("ui-word-gloss", "light", async (p) => { await search(p, "rayke"); await p.waitForSelector(".hit"); await p.click("#t-gloss"); });
// Homograph alternates: `pa` displays NOUN “head” with alt PL / mouth (gloss mode).
await shoot("ui-word-alt-dark", "dark", async (p) => { await search(p, "pa"); await p.waitForSelector(".hit"); await p.click("#t-gloss"); });
await shoot("ui-word-dark", "dark", async (p) => { await search(p, "arpa"); await p.waitForSelector(".hit"); });
await shoot("ui-bible-source", "light", async (p) => { await search(p, "opopmaw"); await p.waitForSelector(".variant-row"); });
await shoot("ui-options-open", "light", async (p) => { await p.click("#opts-summary"); await search(p, "rayke"); await p.waitForSelector(".hit"); });
await shoot("ui-filter-pos", "light", async (p) => { await search(p, "pos:VERB next:=an"); await p.waitForSelector(".hit"); });
await shoot("ui-phrase", "light", async (p) => { await search(p, "kamuy kor"); await p.waitForSelector(".hit"); });
await shoot("ui-pattern", "light", async (p) => { await search(p, "[upos=NOUN] [upos=NOUN]"); await p.waitForSelector(".hit"); });
await shoot("ui-prefix", "light", async (p) => { await search(p, "kamuy*"); await p.waitForSelector(".hit"); });
await shoot("ui-collocates", "light", async (p) => { await search(p, "kamuy"); await p.waitForSelector(".hit"); await tab(p, "collocates"); await p.waitForSelector("table.data"); });
await shoot("ui-distribution", "light", async (p) => { await search(p, "kamuy"); await p.waitForSelector(".hit"); await tab(p, "distribution"); await p.waitForSelector(".dist-grid"); });
await shoot("ui-forms", "light", async (p) => { await search(p, "arpa"); await p.waitForSelector(".hit"); await tab(p, "forms"); await p.waitForSelector("table.data"); });
// corpus_fts only exists in the production DB — locally this renders the error
// state, which is still worth eyeballing.
await shoot("ui-text-ja", "light", async (p) => { await search(p, "神"); await p.waitForSelector(".hit, .empty", { timeout: 4000 }).catch(() => {}); });

await browser.close();
server.stop();
