import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { replayView } from "../public/assets/replay-view.js";
import { standingFromBaseline } from "../public/assets/baseline.js";

const replay = JSON.parse(readFileSync(new URL("../public/assets/replay-nvda.json", import.meta.url), "utf8"));
const button = (key, action) => `<button data-action="${action}">${key}</button>`;

test("the replay renders the recorded run in English and Chinese without inventing values", () => {
  for (const language of ["en", "zh"]) {
    const html = replayView(replay, language, button);
    const run = replay.runs[0];
    assert.match(html, /0001045810-26-000078/);
    assert.match(html, /0001104659-26-103913/);
    assert.ok(html.includes(run.run_id) && html.includes(run.record_sha256.slice(0, 12)));
    const relevant = run.events.find(e => e.accession === "0001045810-26-000078");
    for (const fact of relevant.what_changed.observed_facts.filter(f => f.kind === "verbatim_quote"))
      assert.ok(html.includes(fact.exact_quote.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")));
    assert.ok(!/undefined|NaN|\[object Object\]/.test(html), language);
    // The superseded Case A assessment no longer asks the Owner for a decision.
    assert.match(html, language === "zh" ? /决定请求已撤回/ : /Decision request withdrawn/);
    assert.ok(!html.includes(language === "zh" ? "等待 Owner 做出决定" : "Awaiting the Owner&#39;s decision"));
  }
});

test("the correction, annotations, reassessment and labelled scenario are all shown", () => {
  for (const language of ["en", "zh"]) {
    const html = replayView(replay, language, button);
    assert.match(html, /class="replay-correction"/);
    for (const a of replay.annotations) assert.ok(html.includes(`data-annotation="${a.id}"`), a.id);
    assert.ok(html.includes("W5.1 remains a monitoring gap"));          // recorded model text shown unchanged
    const reassessment = replay.runs.find(r => r.supersedes);
    assert.ok(html.includes(`data-run="${reassessment.run_id}"`));
    assert.match(html, language === "zh" ? /仅属驱动因素背景/ : /Driver context only/);
    const scenario = replay.scenarios[0];
    assert.ok(html.includes(`data-scenario="${scenario.id}"`));
    assert.match(html, language === "zh" ? /不是 Owner 的论点/ : /NOT THE OWNER&#39;S THESIS/);
    assert.match(html, language === "zh" ? /仅限情景/ : /Scenario only/);
    for (const a of scenario.annotations) assert.ok(html.includes(`data-annotation="${a.id}"`), a.id);
    assert.ok(html.includes("0001045810-25-000082"));
  }
});

test("the scenario is never presented as the Owner's thesis or decision", () => {
  const html = replayView(replay, "en", button);
  const scenario = html.slice(html.indexOf('class="replay-scenario"'));
  assert.ok(!scenario.includes("Awaiting the Owner&#39;s decision") && !scenario.includes("Owner-approved baseline"));
  assert.match(scenario, /not Owner-approved/);
});

test("model text is escaped, never interpreted as markup", () => {
  const hostile = structuredClone(replay);
  hostile.runs[0].events[1].stage1.output.rationale = "<img src=x onerror=alert(1)>";
  assert.ok(!replayView(hostile, "en", button).includes("<img src=x"));
});

test("a recorded test decision is labelled as a test, never as the Owner's", () => {
  const withTest = structuredClone(replay);
  const assessed = withTest.runs[0].events.find(e => e.accession === "0001045810-26-000078");
  withTest.decisions = [{ event_id: assessed.event_id, assessment_id: assessed.assessment.assessment_id, action: "keep_unresolved", changed: false,
    from_version: 1, version: 1, actor: { kind: "automated_test", label: "x" }, decided_at: "t" }];
  const html = replayView(withTest, "en", button);
  assert.match(html, /Automated test decision · not an Owner decision/);
  assert.ok(!html.includes("Awaiting the Owner&#39;s decision"));
});

test("the check-standing projection equals the browser's adopted Standing", () => {
  const projection = JSON.parse(readFileSync(new URL("../../backend/src/living_thesis/nvda_check_standing.json", import.meta.url), "utf8"));
  assert.deepEqual(projection.hosted_standing, standingFromBaseline("en"));
});
