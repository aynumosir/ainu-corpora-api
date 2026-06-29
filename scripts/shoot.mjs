#!/usr/bin/env bun
/** Serve public/ and screenshot the UI (KWIC + POS) in light & dark, hitting the
 * live corpus.aynu.org API (CORS-open). Outputs build/ui-*.png for visual review. */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const root = new URL("../public/", import.meta.url).pathname;
mkdirSync(new URL("../build/", import.meta.url).pathname, { recursive: true });

const server = Bun.serve({
  port: 0,
  fetch(req) {
    let p = new URL(req.url).pathname;
    if (p === "/") p = "/index.html";
    return new Response(Bun.file(root + p.slice(1)));
  },
});
const base = `http://localhost:${server.port}`;
const browser = await chromium.launch();

async function shoot(name, scheme, setup) {
  const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1200, height: 860 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: "networkidle" });
  await setup(page);
  await page.click("button.go");
  await page.waitForSelector(".hit", { timeout: 15000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: new URL(`../build/${name}.png`, import.meta.url).pathname });
  console.log(name, "->", await page.$$eval(".hit", (h) => h.length), "hits");
  await ctx.close();
}

const kwic = async (p) => { await p.fill("#q", "rayke"); await p.selectOption("#sort", "right"); };
const pos = async (p) => {
  await p.click('.modes button[data-mode="pos"]');
  await p.selectOption("#upos", "VERB");
  await p.fill("#next", "=an");
};

await shoot("ui-kwic-light", "light", kwic);
await shoot("ui-kwic-dark", "dark", kwic);
await shoot("ui-pos-light", "light", pos);

await browser.close();
server.stop();
