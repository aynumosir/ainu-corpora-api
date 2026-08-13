#!/usr/bin/env bun
/**
 * Screenshot the statistics page (public/stats.html + public/stats.json) for
 * visual review: every section in light & dark at desktop width, plus a
 * mobile pass. Outputs build/stats-*.png.
 *
 *   bun scripts/shoot_stats.mjs
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const ROOT = new URL("../public/", import.meta.url).pathname;
mkdirSync(new URL("../build/", import.meta.url).pathname, { recursive: true });

const TYPES = { html: "text/html", json: "application/json" };
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    let p = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (!p.includes(".")) p += ".html";
    const ext = p.split(".").pop();
    return new Response(Bun.file(ROOT + p), { headers: { "content-type": TYPES[ext] ?? "text/plain" } });
  },
});
const base = `http://localhost:${server.port}`;
const browser = await chromium.launch();

async function shoot(name, scheme, { width = 1240, height = 940, section = null, fullPage = false, fn = null } = {}) {
  const ctx = await browser.newContext({
    colorScheme: scheme,
    viewport: { width, height },
    deviceScaleFactor: 1.5,
    reducedMotion: "reduce",
  });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log(`[${name}] console error:`, m.text()); });
  page.on("pageerror", (e) => console.log(`[${name}] page error:`, e.message));
  await page.goto(base + "/stats", { waitUntil: "networkidle" });
  if (section) await page.locator(section).scrollIntoViewIfNeeded();
  if (fn) await fn(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: new URL(`../build/${name}.png`, import.meta.url).pathname, fullPage });
  console.log(name, "ok");
  await ctx.close();
}

await shoot("stats-hero", "light");
await shoot("stats-hero-dark", "dark");
await shoot("stats-registers", "light", { section: "#registers" });
await shoot("stats-registers-dark", "dark", { section: "#registers" });
await shoot("stats-dialects", "light", { section: "#dialects" });
await shoot("stats-lexicon", "light", { section: "#lexicon" });
await shoot("stats-lexicon-dark", "dark", { section: "#lexicon" });
await shoot("stats-fingerprints", "light", { section: "#histgrid" });
await shoot("stats-fingerprints-dark", "dark", { section: "#histgrid" });
await shoot("stats-phrases", "light", { section: "#chips-phrases" });
await shoot("stats-keywords", "light", { section: "#keywords" });
await shoot("stats-keywords-dark", "dark", { section: "#keywords" });
await shoot("stats-grammar", "light", { section: "#grammar" });
await shoot("stats-grammar-dark", "dark", { section: "#grammar" });
await shoot("stats-collections", "light", { section: "#collections" });
await shoot("stats-methods", "light", { section: "#methods" });
// pinned state: pin social via a strip segment, then look at fingerprints
await shoot("stats-pinned", "light", {
  section: "#histgrid",
  fn: async (p) => { await p.click('#strip .seg[data-reg="social"]'); },
});
await shoot("stats-mobile", "light", { width: 375, height: 800 });
await shoot("stats-mobile-registers", "light", { width: 375, height: 800, section: "#registers" });

await browser.close();
server.stop();
