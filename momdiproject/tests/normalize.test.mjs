import test from "node:test";
import assert from "node:assert/strict";

const mod = await import("../dist/src/utils/normalizeUrl.js");

test("normalizes LinkedIn profile URL", () => {
  assert.equal(mod.normalizeLinkedInUrl(" https://linkedin.com/in/example/?trk=abc "), "https://www.linkedin.com/in/example/");
});

test("rejects non-LinkedIn URLs", () => {
  assert.throws(() => mod.normalizeLinkedInUrl("https://example.com/in/x"));
});

test("rejects http", () => {
  assert.throws(() => mod.normalizeLinkedInUrl("http://linkedin.com/in/x"));
});
