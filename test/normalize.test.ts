/** Tests for the shared normalization layer (accent folding etc.). */
import { test, expect } from "bun:test";
import { normToken, foldAccents, foldToken, isClitic, isGlottalMarker } from "../src/normalize.ts";

test("normToken lowercases and strips edge apostrophes", () => {
  expect(normToken("Néa")).toBe("néa");
  expect(normToken("'aynu'")).toBe("aynu");
  expect(normToken("ku=")).toBe("ku=");
});

test("foldAccents removes pitch acute / length circumflex / macron", () => {
  expect(foldAccents("néa")).toBe("nea");
  expect(foldAccents("rámat")).toBe("ramat");
  expect(foldAccents("kotàn")).toBe("kotan");
  expect(foldAccents("â")).toBe("a");
  expect(foldAccents("ā")).toBe("a");
});

test("foldToken is accent-insensitive and equates marked/unmarked", () => {
  expect(foldToken("Rámat")).toBe("ramat");
  expect(foldToken("ramat")).toBe("ramat");
  expect(foldToken("Néa")).toBe(foldToken("nea"));
});

test("foldToken preserves the clitic boundary =", () => {
  expect(foldToken("=an")).toBe("=an");
  expect(foldToken("ku=")).toBe("ku=");
});

test("apostrophe variants fold together", () => {
  expect(foldToken("po’ro")).toBe(foldToken("po'ro"));
});

test("glottal-stop apostrophes are dropped in the fold key", () => {
  // Word-internal glottal stop (Murasaki Sakhalin transcriptions): the marked
  // and unmarked spellings of the same word must collide on the fold key.
  expect(foldToken("ne'ampe")).toBe("neampe");
  expect(foldToken("haw'as")).toBe("hawas");
  expect(foldToken("'isam")).toBe("isam");
  expect(foldToken("ne'ampe")).toBe(foldToken("neampe"));
  expect(foldToken("'isam")).toBe(foldToken("isam"));
});

test("clitic '=' survives folding but glottal apostrophe does not", () => {
  expect(foldToken("an='e")).toBe("an=e");
  expect(foldToken("=an")).toBe("=an");
});

test("isGlottalMarker flags standalone apostrophe/quote tokens only", () => {
  expect(isGlottalMarker("'")).toBe(true);
  expect(isGlottalMarker("’")).toBe(true);
  expect(isGlottalMarker("\"")).toBe(true);
  expect(isGlottalMarker("''")).toBe(true);
  expect(isGlottalMarker("")).toBe(false);
  expect(isGlottalMarker(".")).toBe(false);
  expect(isGlottalMarker(",")).toBe(false);
  expect(isGlottalMarker("isam")).toBe(false);
  expect(isGlottalMarker("ne'ampe")).toBe(false);
});

test("isClitic detects leading/trailing =", () => {
  expect(isClitic("ku=")).toBe(true);
  expect(isClitic("=an")).toBe(true);
  expect(isClitic("arpa")).toBe(false);
});
