#!/usr/bin/env bun
/**
 * Serve the UI against a LOCAL bun:sqlite copy of the corpus (build/corpus.db)
 * mounting the real Hono app, and screenshot every search mode (KWIC w/ gloss,
 * POS lemma, collocation, structural, analytics, forms) in light & dark for visual review.
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

const go = (p) => p.click("button.go");
await shoot("ui-kwic-gloss", "light", async (p) => { await p.fill("#q", "rayke"); await p.selectOption("#sort", "r1"); await go(p); await p.waitForSelector(".hit"); await p.click("#t-gloss"); });
await shoot("ui-kwic-dark", "dark", async (p) => { await p.fill("#q", "arpa"); await p.selectOption("#expand", "plural"); await go(p); await p.waitForSelector(".hit"); });
await shoot("ui-pos-lemma", "light", async (p) => { await p.click('.modes button[data-mode="pos"]'); await p.fill("#lemma", "arpa"); await go(p); await p.waitForSelector(".hit"); });
await shoot("ui-collocation", "light", async (p) => { await p.click('.modes button[data-mode="collocation"]'); await p.fill("#q", "kamuy"); await go(p); await p.waitForSelector("table.data"); });
await shoot("ui-structural", "light", async (p) => { await p.click('.modes button[data-mode="structural"]'); await p.fill("#q", "[upos=NOUN] [upos=NOUN]"); await go(p); await p.waitForSelector(".hit"); });
await shoot("ui-analytics", "light", async (p) => { await p.click('.modes button[data-mode="analytics"]'); await p.fill("#q", "kamuy"); await go(p); await p.waitForSelector(".analytics-grid"); });
await shoot("ui-forms", "light", async (p) => { await p.click('.modes button[data-mode="inflection"]'); await p.fill("#q", "arpa"); await go(p); await p.waitForSelector("table.data"); });

await browser.close();
server.stop();
