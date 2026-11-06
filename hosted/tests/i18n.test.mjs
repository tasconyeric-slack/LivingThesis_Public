import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { messages, chooseLanguage, translate } from "../public/assets/i18n.js";
test("language preference wins; otherwise Chinese browser locales use Chinese", () => {
  assert.equal(chooseLanguage("en", "zh-CN"), "en");
  assert.equal(chooseLanguage("zh", "en-US"), "zh");
  for (const locale of ["zh", "zh-CN", "zh-Hant-TW"])
    assert.equal(chooseLanguage(null, locale), "zh");
  assert.equal(chooseLanguage("invalid", "fr-FR"), "en");
});
test("bilingual dictionaries cover static chrome and preserve interpolation tokens", () => {
  assert.deepEqual(Object.keys(messages.en), Object.keys(messages.zh));
  for (const key of Object.keys(messages.en)) {
    assert.ok(messages.zh[key]);
    assert.deepEqual(
      [...messages.en[key].matchAll(/\{\w+\}/g)].map((m) => m[0]).sort(),
      [...messages.zh[key].matchAll(/\{\w+\}/g)].map((m) => m[0]).sort(),
    );
  }
  const app = ["app.js", "baseline-view.js", "replay-view.js", "check-view.js"].map(file => readFileSync(
    new URL(`../public/assets/${file}`, import.meta.url), "utf8",
  )).join("\n");
  for (const match of app.matchAll(/\b(?:tr|t|button|pill)\("([^"\n]+)"/g))
    assert.ok(messages.zh[match[1]], `Missing ${match[1]}`);
  assert.equal(
    translate("zh", "Standing v{version}", { version: 2 }),
    "当前投资逻辑 v2",
  );
});
test("translation accepts UI keys, not arbitrary artifact translation", () => {
  const original = "The source has  two spaces.\n原始观点";
  assert.equal(translate("zh", original), original);
  const value = "<script>alert(1)</script>";
  assert.equal(
    translate("en", "{count} assumptions", { count: value }),
    `${value} assumptions`,
  );
  // Rendering owns HTML escaping; the dictionary does not reinterpret user data.
});
