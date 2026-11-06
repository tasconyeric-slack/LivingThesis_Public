import assert from "node:assert/strict";
import { translate } from "../public/assets/i18n.js";
import { authFixtureSdk } from "./durable.browser.mjs";

// Check for Updates in a real browser against the loopback durable fixture. SEC filings and model
// outputs are SYNTHETIC (hosted/tests/check_fixture.py); the API, domain rules and check core are real.
export async function checkFlowChecks(browser, base, users) {
  const errors = [], contexts = [];
  const text = (lang, key, params) => translate(lang, key, params);
  async function page(viewport, lang) {
    const context = await browser.newContext({ viewport });
    await context.route("**/assets/supabase.js", (route) => route.fulfill({ contentType: "text/javascript", body: authFixtureSdk(users) }));
    context.on("page", (p) => p.on("pageerror", (error) => errors.push(error.message)));
    contexts.push(context);
    const value = await context.newPage();
    await value.goto(base);
    await value.getByRole("button", { name: lang === "en" ? "EN" : "中文", exact: true }).click();
    return value;
  }
  const click = (p, lang, key, params) => p.getByRole("button", { name: text(lang, key, params), exact: true }).last().click();
  async function signIn(p, lang, who) {
    await click(p, lang, "Sign in");
    await p.locator("#auth-email").fill(`user-${who}@example.test`);
    await click(p, lang, "Send sign-in email");
    await p.locator("#auth-code").fill("123456");
    await click(p, lang, "Verify code");
    await p.getByRole("button", { name: text(lang, "Sign out"), exact: true }).waitFor();
  }
  const workspaces = async (p, who) => (await (await p.request.get(`${base}/api/workspaces`, { headers: { Authorization: `Bearer fixture-user-${who}` } })).json()).workspaces;
  const noOverflow = async (p) => {
    const wide = await p.evaluate(() => [...document.querySelectorAll("body *")].filter((n) => n.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 5).map((n) => `${n.tagName}.${n.className} ${Math.round(n.getBoundingClientRect().right)} ${n.textContent.slice(0, 60)}`));
    assert.deepEqual(wide, [], "no element overflows the viewport");
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  };
  try {
    // ---- English, desktop: adopt, check, decide, reconfirm, recheck, inspect history.
    const en = await page({ width: 1440, height: 900 }, "en");
    await signIn(en, "en", "b");
    await en.locator('.baseline-tile [data-action="baseline"]').click();
    await click(en, "en", "Adopt this baseline as my NVDA workspace →");
    await en.getByRole("heading", { name: "Check for Updates", exact: true }).waitFor();
    let [row] = (await workspaces(en, "b")).filter((w) => w.current_state.standing.ticker === "NVDA");
    assert.equal(row.current_state.lineage.baseline_content_sha256.slice(0, 8), "634b8121");
    assert.equal(await en.locator(".check-card .check-lineage").count(), 1);

    // One lost response mid-check: the retry carries the same key and the run continues.
    let steps = 0, failed = false;
    const keys = [];
    await en.route("**/api/workspaces/*/check", async (route) => {
      steps++;
      keys.push(route.request().postDataJSON().idempotency_key);
      if (steps === 2 && !failed) {
        failed = true;
        const committed = await route.fetch();
        assert.equal(committed.status(), 200);
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "cloud_unavailable" } }) });
      }
      return route.continue();
    });
    await click(en, "en", "Check for Updates");
    await en.locator(".check-card .alert").waitFor();
    await click(en, "en", "Continue check");
    await en.locator('.check-result[data-outcome="assessment_needs_review"]').waitFor();
    assert.equal(keys[1], keys[2], "the retried step reuses its idempotency key");
    await en.unroute("**/api/workspaces/*/check");
    // The validated filing assessment opens for an explicit human decision.
    const panel = en.locator(".action-panel");
    await panel.getByText("Retrieved from SEC EDGAR by the server", { exact: true }).waitFor();
    await panel.getByRole("heading", { name: "Watch Item questions answered", exact: true }).waitFor();
    row = (await workspaces(en, "b")).find((w) => w.id === row.id);
    assert.equal(row.active_thesis_version, 1, "a check never changes the Standing");
    assert.equal(row.current_state.assessments.length, 1);
    await en.locator('input[value="accept"]').check();
    await click(en, "en", "Apply human decision →");
    await panel.waitFor({ state: "hidden" });
    // A revised thesis must reconfirm the approved monitoring rules before the next check.
    await click(en, "en", "Confirm monitoring rules for v{version}", { version: 2 });
    await en.getByRole("button", { name: "Check for Updates", exact: true }).waitFor();
    await click(en, "en", "Check for Updates");
    await en.locator('.check-result[data-outcome="no_new_material_evidence"]').waitFor();
    row = (await workspaces(en, "b")).find((w) => w.id === row.id);
    const last = row.current_state.checks.runs.at(-1);
    assert.equal(last.totals.model_calls, 0, "rechecking processed filings makes no model call");
    assert.equal(row.current_state.assessments.length, 1, "no duplicate assessment");
    assert.equal(last.standing_version, 2);
    await en.reload();
    await en.locator('.check-result[data-outcome="no_new_material_evidence"]').waitFor();
    await en.getByRole("tab", { name: "History", exact: true }).click();
    await en.getByRole("heading", { name: "Check for Updates runs", exact: true }).waitFor();
    await en.locator(".check-run").first().getByRole("button", { name: "Show run record", exact: true }).click();
    await en.getByText("Integrity verified: every saved part matches the run's recorded hashes.", { exact: true }).waitFor();
    await en.locator(".check-run").last().getByRole("button", { name: "Show run record", exact: true }).click();
    await en.locator('.check-run .replay-event[data-event="edgar:0001045810-26-900001"]').waitFor();
    await noOverflow(en);

    // ---- Chinese, mobile: the same journey for another investor, with an explicit Keep unresolved.
    const zh = await page({ width: 390, height: 844 }, "zh");
    await signIn(zh, "zh", "a");
    await zh.locator('.baseline-tile [data-action="baseline"]').click();
    await click(zh, "zh", "Adopt this baseline as my NVDA workspace →");
    await zh.getByRole("heading", { name: text("zh", "Check for Updates"), exact: true }).waitFor();
    await click(zh, "zh", "Check for Updates");
    await zh.locator('.check-result[data-outcome="assessment_needs_review"]').waitFor();
    await noOverflow(zh);
    await zh.locator('input[value="keep_unresolved"]').check();
    await click(zh, "zh", "Apply human decision →");
    await zh.locator(".action-panel").waitFor({ state: "hidden" });
    const [mine] = (await workspaces(zh, "a")).filter((w) => w.current_state.standing.ticker === "NVDA");
    assert.equal(mine.active_thesis_version, 1);
    assert.equal(mine.current_state.decisions.at(-1).action, "keep_unresolved");
    assert.equal(mine.current_state.lineage.language, "zh");
    // Isolation: investor A cannot read investor B's check run.
    const denied = await zh.request.get(`${base}/api/workspaces/${row.id}/checks/${last.run_id}`, { headers: { Authorization: "Bearer fixture-user-a" } });
    assert.equal(denied.status(), 404);
    await noOverflow(zh);
    assert.deepEqual(errors, []);
    console.log("Check for Updates browser acceptance passed: adoption, resumable check with a lost response, decision, monitoring reconfirmation, zero-cost recheck, run history, EN desktop and ZH mobile, isolation.");
  } catch (error) {
    console.error("Check browser page errors:", errors);
    for (const value of contexts) for (const p of value.pages())
      console.error("Check browser state:", await p.evaluate(() => ({ alerts: [...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent),
        buttons: [...document.querySelectorAll("button")].map((b) => b.textContent) })));
    throw error;
  } finally { for (const value of contexts) await value.close(); }
}
