import test from "node:test";
import assert from "node:assert/strict";
import { baseline } from "../public/assets/baseline.js";
import { contentSha256 } from "../baseline-artifact.mjs";

test("shipped baseline content matches its recorded approval hash", () => {
  assert.equal(contentSha256(baseline), baseline.provenance.contentSha256);
  assert.equal(baseline.provenance.approval.contentSha256, baseline.provenance.contentSha256);
  const edited = structuredClone(baseline);
  edited.statement.en += " changed";
  assert.notEqual(contentSha256(edited), baseline.provenance.contentSha256);
});
