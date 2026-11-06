import { translate } from "../public/assets/i18n.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCard, checkStatus, runResult, acquisitionNote } from "../public/assets/check-view.js";

const button = (key, action) => `<button data-action="${action}">${key}</button>`;
const alert = (code) => `<div role="alert">${code}</div>`;
const lineage = { baseline_content_sha256: "634b812149c40bc129221b0ba451e210319fdc17847e1b80a8c91528777150ee", adopted_at: "2026-10-18T07:00:00Z",
  monitoring: [{ version: 1, statement_sha256: "a".repeat(64), basis: "adoption", time: "2026-10-18T07:00:00Z" }] };
const run = (outcome, extra = {}) => ({ run_id: "chk_20261019T000000Z_abcdef", outcome, run_at: "2026-10-19T00:00:00Z", as_of: "2026-10-19T00:00:00Z",
  reviewed_through_after: outcome === "partial_failure" ? null : "2026-10-19T00:00:00Z", standing_version: 1, stopped: null,
  window: { evidence_through: "2026-08-26" }, totals: { model_calls: 0, deep_research_calls: 0, tokens: {} },
  funnel: { in_window: 0, stage0_filtered: 0, stage0_kept: 0, stage0_failed: 0, watch_item_evidence: 0, uncertain: 0, assessments: 0 },
  events: [], record_sha256: "b".repeat(64), ...extra });
const workspace = (extra = {}) => ({ id: "w1", mode: "custom", standing: { ticker: "NVDA", version: 1 }, lineage, checks: { active: null, runs: [] }, ...extra });

test("eligibility shown in the browser mirrors the server's version rule; the server decides", () => {
  assert.equal(checkStatus(workspace()), "eligible");
  assert.equal(checkStatus(workspace({ standing: { ticker: "NVDA", version: 2 } })), "revalidation_required");
  assert.equal(checkStatus(workspace({ lineage: undefined })), "not_eligible");
});

test("an NVDA workspace without server lineage explains why it cannot be checked; other tickers show nothing", () => {
  const html = checkCard(workspace({ lineage: undefined }), { language: "en", button, alert });
  assert.match(html, /adopted from the Owner-approved NVIDIA baseline/);
  assert.doesNotMatch(html, /data-action="check-updates"/);
  assert.equal(checkCard(workspace({ lineage: undefined, standing: { ticker: "MSFT", version: 1 } }), { language: "en", button, alert }), "");
});

test("a revised thesis asks for monitoring reconfirmation instead of a check", () => {
  const html = checkCard(workspace({ standing: { ticker: "NVDA", version: 2 } }), { language: "en", button, alert });
  assert.match(html, /data-action="confirm-monitoring"/);
  assert.doesNotMatch(html, /data-action="check-updates"/);
});

test("every outcome is named and an empty result never claims nothing happened", () => {
  for (const [outcome, label] of [["no_new_material_evidence", "No new material evidence"], ["driver_context_only", "Driver context only"],
    ["assessment_needs_review", "Assessment needs your review"], ["partial_failure", "Partial failure · retry"], ["incomplete_coverage", "Incomplete coverage"]])
    assert.match(runResult(run(outcome), "en"), new RegExp(label.replace("·", ".")));
  assert.match(runResult(run("no_new_material_evidence"), "en"), /not proof that nothing happened/);
  assert.match(runResult(run("partial_failure"), "en"), /Not advanced by this check/);
});

test("filings excluded after repeated failure are never shown as a clean or complete review", () => {
  const unreviewed = [{ accession: "0001045810-26-000777", form: "8-K", filing_date: "2026-09-02", last_error: "triage_blocked" }];
  for (const language of ["en", "zh"]) {
    const html = runResult(run("incomplete_coverage", { reviewed_through_after: null,
      window: { evidence_through: "2026-08-26", unreviewed_after_repeated_failure: unreviewed } }), language);
    assert.match(html, /data-outcome="incomplete_coverage"/);
    assert.match(html, /0001045810-26-000777/);
    assert.doesNotMatch(html, new RegExp(translate(language, "No new material evidence")));
    assert.match(html, new RegExp(translate(language, "Not advanced by this check")));
    assert.match(html, new RegExp(translate(language, "Incomplete coverage")));
  }
});

test("filing text and identifiers are escaped", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const html = runResult(run("driver_context_only", { events: [{ event_id: "edgar:x", accession: evil, form: "8-K", filing_date: "2026-10-01",
    url: "javascript:alert(1)\" onmouseover=\"x", stage0: { result: "candidate" }, result: "driver_context", rationale: evil,
    watch_item_ids: [], driver_context_ids: ["D3"], failure: null, hold: null }] }), "en");
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /" onmouseover="/);
  const note = acquisitionNote({ acquisition: { form: "8-K", accession: evil, filing_date: "x", accepted_at: "y",
    sources: [{ url: "https://www.sec.gov/a", sha256: "c".repeat(64) }] } }, "zh");
  assert.doesNotMatch(note, /<img/);
  assert.match(note, /由服务器从 SEC EDGAR 获取/);
});
