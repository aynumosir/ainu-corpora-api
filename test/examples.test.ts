/**
 * Tests for the curated search-examples catalogue (src/examples.ts).
 *
 * These guard that every example is a well-formed, runnable spec: the derived
 * `path` is a valid relative API URL, its querystring round-trips the declared
 * `params`, the `mode` is known, and the `path` targets the endpoint that mode
 * implies. They double as a contract check so the UI/consumers can trust the
 * catalogue without re-deriving anything.
 */
import { test, expect } from "bun:test";
import { SEARCH_EXAMPLES, examplesFor, type ExampleMode } from "../src/examples.ts";

const MODE_ENDPOINT: Record<ExampleMode, string> = {
  kwic: "/v1/kwic",
  pos: "/v1/pos",
  collocation: "/v1/collocation",
  structural: "/v1/structural",
  analytics: "/v1/analytics",
  inflection: "/v1/inflections",
  text: "/v1/search",
};

test("catalogue is non-empty and covers every mode", () => {
  expect(SEARCH_EXAMPLES.length).toBeGreaterThan(0);
  const modes = new Set(SEARCH_EXAMPLES.map((e) => e.mode));
  for (const m of Object.keys(MODE_ENDPOINT) as ExampleMode[]) {
    expect(modes.has(m)).toBe(true);
  }
});

test("every example is well-formed and runnable", () => {
  for (const e of SEARCH_EXAMPLES) {
    expect(e.label.trim().length).toBeGreaterThan(0);
    expect(e.desc.trim().length).toBeGreaterThan(0);
    expect(Object.keys(e.params).length).toBeGreaterThan(0);

    // path = endpoint?querystring, endpoint matches the mode.
    const [base, query] = e.path.split("?");
    expect(base).toBe(MODE_ENDPOINT[e.mode]);
    expect(query).toBeTruthy();

    // querystring round-trips the declared params exactly.
    const parsed = Object.fromEntries(new URLSearchParams(query));
    expect(parsed).toEqual(e.params);
  }
});

test("examplesFor() with no mode returns the whole catalogue", () => {
  expect(examplesFor()).toEqual(SEARCH_EXAMPLES);
  expect(examplesFor(null)).toEqual(SEARCH_EXAMPLES);
});

test("examplesFor(mode) filters to just that mode", () => {
  for (const m of Object.keys(MODE_ENDPOINT) as ExampleMode[]) {
    const got = examplesFor(m);
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((e) => e.mode === m)).toBe(true);
  }
});

test("examplesFor(unknown) is empty", () => {
  expect(examplesFor("nope")).toEqual([]);
});

test("KWIC examples only use params the /v1/kwic route understands", () => {
  const allowed = new Set([
    "q", "ctx", "limit", "sort", "match", "expand", "upos", "clitic", "dialect", "author",
  ]);
  for (const e of examplesFor("kwic")) {
    for (const k of Object.keys(e.params)) expect(allowed.has(k)).toBe(true);
    expect(e.params.q).toBeTruthy(); // KWIC requires q
  }
});

test("structural examples carry a pattern", () => {
  for (const e of examplesFor("structural")) {
    expect(e.params.pattern.trim().length).toBeGreaterThan(0);
  }
});
