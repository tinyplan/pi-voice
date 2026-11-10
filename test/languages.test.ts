import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalLanguage, displayLanguage, languageIdentity } from "../src/languages.js";

test("language identities normalize case, regions, and aliases", () => {
  assert.equal(canonicalLanguage(" TL-ph "), "tl");
  assert.equal(languageIdentity(" TL-ph "), "fil");
  assert.equal(languageIdentity("fil"), "fil");
  assert.equal(languageIdentity("no"), "nb");
  assert.equal(languageIdentity("nb"), "nb");
  assert.equal(languageIdentity("en-GB"), "en");
});

test("language display names distinguish Mandarin and pass codes through", () => {
  assert.equal(displayLanguage("zh"), "Mandarin (Chinese)");
  assert.equal(displayLanguage("zh-CN"), "Mandarin (Chinese)");
  assert.equal(displayLanguage("en"), "English");
  assert.equal(displayLanguage("qzx"), "qzx");
});
