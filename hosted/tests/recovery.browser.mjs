import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const STORAGE = "living-thesis-hosted-v061";
export async function recoveryChecks(
  browser,
  base,
  missingKeyBase,
  capture = async () => {},
) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "Asia/Shanghai",
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.setDefaultTimeout(12000);
  const click = (name) =>
    page.getByRole("button", { name, exact: true }).last().click();
  const stored = () =>
    page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), STORAGE);
  const waitState = (fn) => page.waitForFunction(fn);
  async function create(
    ticker = "FIRST",
    statement = "Growth depends on durable demand, timely execution and resilient margins.",
  ) {
    await click("Add Thesis");
    await page.locator("#ticker").fill(ticker);
    await page.locator("#statement").fill(statement);
    await click("Find my Key Drivers →");
    await page.locator("#review-statement").waitFor();
    await click("Confirm Standing Thesis →");
  }
  async function evidence(
    information = "Timetable moved later",
    source = "The timetable moved from September to December.",
  ) {
    await click("Add Evidence / Analyze Update");
    await page.locator("#information").fill(information);
    await page.locator("#source").fill("Controlled synthetic source");
    await page.locator("#source-text").fill(source);
  }
  await page.goto(base);
  await click("Add Thesis");
  await page.locator("#ticker").fill("FIRST");
  await page
    .locator("#statement")
    .fill(
      "Growth depends on durable demand, timely execution and resilient margins.",
    );
  await click("← My Theses");
  await click("Add Thesis");
  assert.equal(await page.locator("#ticker").inputValue(), "FIRST");
  let releaseCreation;
  const creationGate = new Promise((r) => (releaseCreation = r));
  await page.route("**/api/thesis", async (route) => {
    await creationGate;
    await route.continue();
  });
  await click("Find my Key Drivers →");
  await click("中文");
  releaseCreation();
  await page.locator("#review-statement").waitFor();
  assert.equal((await stored()).creation.language, "en");
  assert.equal(
    (await stored()).creation.proposal.drivers[0].title,
    "Demand durability",
  );
  assert.equal(
    await page.evaluate(() => document.activeElement.dataset.language),
    "zh",
  );
  await page.unroute("**/api/thesis");
  await click("EN");
  await page.locator("#d-title-0").fill("My retained driver draft");
  await click("中文");
  await click("EN");
  await click("← My Theses");
  await click("Add Thesis");
  assert.equal(
    await page.locator("#d-title-0").inputValue(),
    "My retained driver draft",
  );
  // Native minlength accepts padding; confirmation must validate after trimming.
  for (const [selector, value] of [
    ["#review-statement", "          "],
    ["#d-title-0", " a "],
    ["#d-statement-0", " b "],
    ["#d-watch-0", " c "],
  ]) {
    const input = page.locator(selector),
      original = await input.inputValue();
    await input.fill(value);
    await click("Confirm Standing Thesis →");
    await page.getByRole("alert").waitFor();
    assert.equal((await stored()).workspaces.length, 0);
    assert.ok((await stored()).creation.proposal);
    assert.equal(await input.inputValue(), value);
    await page.reload();
    assert.equal(await page.locator(selector).inputValue(), value);
    await page.locator(selector).fill(original);
  }
  await click("Confirm Standing Thesis →");
  await click("← My Theses");
  // One workspace per ticker: a duplicate, however it is written, is refused before any
  // model call, and the existing workspace is offered instead.
  let thesisCalls = 0;
  await page.route("**/api/thesis", (route) => {
    thesisCalls++;
    return route.continue();
  });
  await click("Add Thesis");
  await page.locator("#ticker").fill("first");
  await page
    .locator("#statement")
    .fill("A second view on the same company, written again.");
  await click("Find my Key Drivers →");
  await page.getByRole("alert").waitFor();
  assert.equal(thesisCalls, 0);
  assert.equal((await stored()).workspaces.length, 1);
  await click("Open existing workspace");
  await page.getByRole("heading", { name: "FIRST", exact: true }).waitFor();
  await page.unroute("**/api/thesis");
  await click("← My Theses");
  await create("SECOND");
  await page.clock.setFixedTime(new Date("2026-10-05T00:30:00+08:00"));
  await evidence();
  assert.equal(await page.locator("#event-date").inputValue(), "2026-10-05");
  await page.clock.setFixedTime(new Date());
  await page.locator("#information").fill("Second workspace draft");
  await click("← My Theses");
  await page.locator('.thesis-tile [data-action="open"]').first().click();
  await evidence();
  let release;
  const gate = new Promise((r) => (release = r));
  await page.route("**/api/evidence", async (route) => {
    await gate;
    await route.continue();
  });
  await click("Analyze Update →");
  await click("← My Theses");
  await page.locator('.thesis-tile [data-action="open"]').nth(1).click();
  await click("中文");
  release();
  await waitState(
    () =>
      JSON.parse(sessionStorage.getItem("living-thesis-hosted-v061"))
        .workspaces[0].assessments.length === 1,
  );
  let state = await stored();
  assert.equal(state.activeId, state.workspaces[1].id);
  assert.equal(state.workspaces[1].assessments.length, 0);
  assert.equal(
    state.workspaces[1].draft.evidence.information,
    "Second workspace draft",
  );
  assert.equal(state.workspaces[0].assessments[0].language, "en");
  await page.unroute("**/api/evidence");
  await click("EN");
  await click("← My Theses");
  await page.locator('.thesis-tile [data-action="open"]').first().click();
  const unchanged = JSON.stringify((await stored()).workspaces);
  await click("中文");
  await click("EN");
  assert.equal(JSON.stringify((await stored()).workspaces), unchanged);
  // A stale receipt is never a usable decision. Reassessment supersedes it.
  await page.evaluate((key) => {
    const s = JSON.parse(sessionStorage.getItem(key));
    s.workspaces[0].assessments[0].receipt = "1.expired";
    sessionStorage.setItem(key, JSON.stringify(s));
  }, STORAGE);
  await page.reload();
  await click("Analyze this evidence again");
  await click("Analyze Update →");
  await page.locator('input[value="accept"]').waitFor();
  assert.equal(
    (await stored()).workspaces[0].assessments[0].status,
    "superseded",
  );
  await page.locator('input[value="accept"]').check();
  await page.route("**/api/decision", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "stale_assessment",
          message: "Safe fixture expiry error",
        },
      }),
    }),
  );
  await click("Apply human decision →");
  await page
    .getByRole("button", { name: "Analyze this evidence again", exact: true })
    .waitFor();
  assert.equal((await stored()).workspaces[0].standing.version, 1);
  assert.equal((await stored()).workspaces[0].decisions.length, 0);
  assert.equal(await page.locator('input[value="accept"]').count(), 0);
  await page.unroute("**/api/decision");
  await click("Analyze this evidence again");
  await click("Analyze Update →");
  await page.locator('input[value="accept"]').check();
  await click("Apply human decision →");
  await page.locator(".action-panel").waitFor({ state: "hidden" });
  const downloadPromise = page.waitForEvent("download");
  await click("Save thesis as JSON ↓");
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.equal(exported.standing.version, 2);
  assert.equal(exported.versions.length, 2);
  assert.equal(exported.decisions.length, 1);
  await evidence(
    "Observation under review",
    "The timetable remains under review.",
  );
  await click("Analyze Update →");
  await page.locator('input[value="keep_unresolved"]').waitFor();
  assert.equal(await page.locator('input[value="accept"]').isDisabled(), true);
  assert.equal(
    await page
      .getByText(
        "0 drivers · 0 research questions · 0 provider or model calls.",
        { exact: true },
      )
      .count(),
    0,
  );
  await page.locator('input[value="keep_unresolved"]').check();
  await click("Apply human decision →");
  await page.locator(".action-panel").waitFor({ state: "hidden" });
  assert.equal(
    (await stored()).workspaces[0].evidence.at(-1).status,
    "unresolved",
  );
  // A reload interrupts an outstanding request and recovers the original draft.
  await evidence();
  let releaseReload;
  const reloadGate = new Promise((r) => (releaseReload = r));
  await page.route("**/api/evidence", async (route) => {
    await reloadGate;
    await route.continue().catch(() => {});
  });
  await click("Analyze Update →");
  await page.reload();
  releaseReload();
  await page.unroute("**/api/evidence");
  assert.equal((await stored()).workspaces[0].evidence.at(-1).status, "failed");
  assert.equal(
    await page.locator("#source-text").inputValue(),
    "The timetable moved from September to December.",
  );
  await page.getByRole("alert").waitFor();
  // Clearing during a request cannot resurrect a workspace or erase language preference.
  let releaseClear;
  const clearGate = new Promise((r) => (releaseClear = r));
  await page.route("**/api/evidence", async (route) => {
    await clearGate;
    await route.continue();
  });
  await click("Analyze Update →");
  await click("中文");
  await page.locator('[data-action="clear"]').click();
  releaseClear();
  await page.waitForTimeout(500);
  assert.equal((await stored())?.workspaces.length || 0, 0);
  assert.equal(
    await page.evaluate(() =>
      localStorage.getItem("living-thesis-ui-language"),
    ),
    "zh",
  );
  await page.unroute("**/api/evidence");
  await click("EN");
  const xss = '<img src=x onerror="window.injected=true">';
  await create("SAFE", "Growth depends on execution. " + xss);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(await page.locator("main img").count(), 0);
  await evidence("Quoted markup", xss + " The timetable moved later.");
  await click("Analyze Update →");
  await page.locator('input[value="reject"]').waitFor();
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(await page.locator("main img").count(), 0);
  // Migration preserves usable signed artifacts and fails safely on corrupt ones.
  const current = (await stored()).workspaces[0],
    assessment = current.assessments.at(-1),
    legacy = {
      mode: "custom",
      stage: "decision",
      standing: current.standing,
      baseStanding: assessment.baseStanding,
      evidence: current.evidence.at(-1).content,
      assessment: assessment.payload,
      receipt: assessment.receipt,
      history: [],
    };
  await page.evaluate((value) => {
    sessionStorage.removeItem("living-thesis-hosted-v061");
    sessionStorage.setItem("living-thesis-hosted-v06", JSON.stringify(value));
  }, legacy);
  await page.reload();
  await page.locator('input[value="reject"]').waitFor();
  assert.equal(
    (await stored()).workspaces[0].assessments[0].receipt,
    legacy.receipt,
  );
  assert.equal((await stored()).workspaces[0].assessments[0].time, null);
  await page.evaluate(() => {
    const key = "living-thesis-hosted-v061",
      s = JSON.parse(sessionStorage.getItem(key));
    s.workspaces[0].standing.statement = "Unrecorded corrupted statement";
    sessionStorage.setItem(key, JSON.stringify(s));
  });
  await page.reload();
  await page.getByRole("heading", { name: "My Theses", exact: true }).waitFor();
  assert.equal((await stored()).workspaces.length, 0);
  delete legacy.assessment.what_changed;
  await page.evaluate((value) => {
    sessionStorage.removeItem("living-thesis-hosted-v061");
    sessionStorage.setItem("living-thesis-hosted-v06", JSON.stringify(value));
  }, legacy);
  await page.reload();
  await page.getByRole("heading", { name: "My Theses", exact: true }).waitFor();
  assert.equal((await stored()).workspaces.length, 0);
  assert.deepEqual(errors, []);
  // Slow demo assets must not override later navigation or discard creation drafts.
  await click("Add Thesis");
  await page.locator("#ticker").fill("DRAFT");
  await page
    .locator("#statement")
    .fill("My preserved idea depends on execution and demand.");
  let releaseDemo;
  const demoGate = new Promise((r) => (releaseDemo = r));
  await page.route("**/assets/demo.json", async (route) => {
    await demoGate;
    await route.continue();
  });
  await page.locator('[data-action="home"]').first().click();
  await page.locator('[data-action="demo"]').click();
  await page.locator('[data-action="home"]').first().click();
  releaseDemo();
  await page.waitForFunction(
    () =>
      JSON.parse(sessionStorage.getItem("living-thesis-hosted-v061")).workspaces
        .length === 1,
  );
  let demoState = await stored();
  assert.equal(demoState.view, "dashboard");
  assert.equal(demoState.activeId, null);
  assert.equal(demoState.creation.draft.ticker, "DRAFT");
  await page.unroute("**/assets/demo.json");
  await click("Add Thesis");
  assert.equal(await page.locator("#ticker").inputValue(), "DRAFT");
  await click("← My Theses");
  await page.locator('[data-action="open"]').first().click();
  const selectedId = (await stored()).activeId;
  // Re-entering the demo resumes the single sandbox; it never adds another NVDA workspace.
  await page.locator('[data-action="home"]').first().click();
  await page.locator('[data-action="demo"]').click();
  await page.getByRole("tab", { name: "Overview", exact: true }).waitFor();
  demoState = await stored();
  assert.equal(demoState.workspaces.length, 1);
  assert.equal(demoState.activeId, selectedId);
  // A slow restart that finishes after navigation must not leave a dangling selection.
  await click("中文");
  let releaseChineseDemo;
  const chineseDemoGate = new Promise((r) => (releaseChineseDemo = r));
  await page.route("**/assets/demo-zh.json", async (route) => {
    await chineseDemoGate;
    await route.continue();
  });
  await page.locator('[data-action="restart-demo"]').click();
  await page.locator('[data-action="home"]').first().click();
  await page.locator('[data-action="open"]').first().click();
  releaseChineseDemo();
  await page.waitForFunction(() => {
    const s = JSON.parse(sessionStorage.getItem("living-thesis-hosted-v061"));
    return s.workspaces.length === 1 && s.workspaces[0].language === "zh";
  });
  demoState = await stored();
  assert.equal(demoState.view, "workspace");
  assert.equal(demoState.activeId, demoState.workspaces[0].id);
  assert.notEqual(demoState.activeId, selectedId);
  assert.equal(demoState.creation.draft.ticker, "DRAFT");
  await page.unroute("**/assets/demo-zh.json");
  assert.deepEqual(errors, []);
  await page.close();
  const zh = await browser.newPage({
    locale: "zh-CN",
    viewport: { width: 390, height: 844 },
  });
  await zh.goto(base);
  assert.equal(await zh.locator("html").getAttribute("lang"), "zh");
  await capture(zh, "dashboard-zh-390");
  await zh.close();
  if (missingKeyBase) {
    const missing = await browser.newPage();
    await missing.goto(missingKeyBase);
    await missing
      .getByRole("button", { name: "Add Thesis", exact: true })
      .click();
    await missing.locator("#ticker").fill("SAVED");
    await missing
      .locator("#statement")
      .fill("My thesis depends on demand and execution.");
    await missing
      .getByRole("button", { name: "Find my Key Drivers →", exact: true })
      .click();
    await missing.getByRole("alert").waitFor();
    await missing.reload();
    assert.equal(await missing.locator("#ticker").inputValue(), "SAVED");
    await missing
      .getByRole("button", { name: "← My Theses", exact: true })
      .click();
    await missing.locator('[data-action="demo"]').click();
    await missing.getByRole("tab", { name: "Overview", exact: true }).waitFor();
    await missing.close();
  }
  console.log(
    "Recovery, stale-result, workspace race, clear race, draft, locale, export and XSS checks passed",
  );
}
