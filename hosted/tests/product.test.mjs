import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  demoAssessment,
  applyDemoDecision,
  localizeDemo,
} from "../public/assets/product.js";
const data = JSON.parse(
  readFileSync(new URL("../public/assets/demo.json", import.meta.url)),
);

test("irrelevant evidence causes zero research and no revision", () => {
  const a = demoAssessment(data, "irrelevant");
  assert.equal(a.relevant, false);
  assert.deepEqual(a.driver_impacts, []);
  assert.equal(
    data.triggers.irrelevant.diagnostics.retrieval_steps_executed,
    0,
  );
  assert.equal(data.triggers.irrelevant.diagnostics.assessment_call_count, 0);
  assert.throws(() => applyDemoDecision(data.standing, a, "accept"));
});
test("Rubin affects one driver and only two of six research needs", () => {
  const a = demoAssessment(data, "rubin");
  assert.deepEqual(
    a.driver_impacts.map((i) => i.driver_id),
    ["T1.D2"],
  );
  assert.deepEqual(data.triggers.rubin.affected_need_ids, ["N3", "N4"]);
  assert.equal(
    data.triggers.rubin.diagnostics.unrelated_research_needs_rerun,
    0,
  );
  assert.equal(data.standing.version, 1);
});
for (const action of ["accept", "edit", "reject", "keep_unresolved"]) {
  test(`${action} requires an explicit decision and preserves other assumptions`, () => {
    const before = structuredClone(data.standing);
    const result = applyDemoDecision(
      before,
      demoAssessment(data, "rubin"),
      action,
      "A human-edited thesis about later Rubin execution.",
    );
    assert.equal(result.changed, ["accept", "edit"].includes(action));
    assert.equal(result.standing.version, result.changed ? 2 : 1);
    assert.deepEqual(result.standing.drivers, before.drivers);
    assert.deepEqual(before, data.standing);
    if (action === "accept")
      assert.equal(result.standing.statement, data.accepted_statement);
  });
}
test("unknown events, absent decisions and empty edits do not mutate a thesis", () => {
  assert.throws(() => demoAssessment(data, "unknown"));
  const a = demoAssessment(data, "rubin");
  assert.throws(() => applyDemoDecision(data.standing, a));
  assert.throws(() => applyDemoDecision(data.standing, a, "edit", ""));
  assert.equal(data.standing.version, 1);
});

test("authored Chinese demo preserves source quotes, IDs and bounded research", () => {
  const overlay = JSON.parse(
    readFileSync(new URL("../public/assets/demo-zh.json", import.meta.url)),
  );
  const before = structuredClone(data),
    zh = localizeDemo(data, overlay),
    a = demoAssessment(zh, "rubin");
  assert.deepEqual(data, before);
  assert.equal(zh.standing.drivers[1].title, "Rubin 量产执行");
  assert.deepEqual(zh.triggers, data.triggers);
  assert.equal(zh.events.rubin.source_text, data.events.rubin.source_text);
  assert.equal(a.driver_impacts[0].exact_quote, data.events.rubin.source_text);
  assert.deepEqual(
    a.driver_impacts.map((i) => i.driver_id),
    ["T1.D2"],
  );
  assert.match(a.reasoning, /合成观察/);
  assert.equal(
    applyDemoDecision(zh.standing, a, "accept").standing.statement,
    overlay.proposed_change.revised_statement,
  );
  assert.equal(demoAssessment(zh, "irrelevant").relevant, false);
});
