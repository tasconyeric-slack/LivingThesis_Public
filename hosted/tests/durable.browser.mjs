import assert from "node:assert/strict";
import { translate } from "../public/assets/i18n.js";

// This SDK replacement is installed only by loopback browser tests. Production
// always imports the bundled official SDK and verifies real bearer credentials.
export function authFixtureSdk(users) {
  return `
const users = ${JSON.stringify(users)};
export function createClient() {
  const listeners = [];
  const read = () => JSON.parse(localStorage.getItem("fixture-auth-session") || "null");
  const emit = (session) => listeners.forEach((fn) => fn(session ? "SIGNED_IN" : "SIGNED_OUT", session));
  return { auth: {
    onAuthStateChange(fn) { listeners.push(fn); return { data: { subscription: { unsubscribe() {} } } }; },
    async getSession() { return { data: { session: read() }, error: null }; },
    async signInWithOtp() { return { error: null }; },
    async verifyOtp({ email, token }) {
      if (token !== "123456") return { error: { message: "Fixture wrong code" } };
      const who = email === "user-b@example.test" ? "b" : "a";
      const session = { access_token: "fixture-user-" + who, user: { id: users[who], email } };
      localStorage.setItem("fixture-auth-session", JSON.stringify(session));
      emit(session);
      return { data: { session }, error: null };
    },
    async signOut() { localStorage.removeItem("fixture-auth-session"); emit(null); return { error: null }; }
  } };
}`;
}

export async function durableChecks(browser, base, users) {
  const errors = [];
  const sdk = authFixtureSdk(users);
  const contexts = [];
  const storage = "living-thesis-hosted-v061";
  async function context(options = {}) {
    const value = await browser.newContext(options);
    await value.route("**/assets/supabase.js", (route) => route.fulfill({ contentType: "text/javascript", body: sdk }));
    value.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    contexts.push(value);
    return value;
  }
  const text = (lang, key) => translate(lang, key);
  const click = (page, lang, key) => page.getByRole("button", { name: text(lang, key), exact: true }).last().click();
  async function signIn(page, lang = "en", who = "a") {
    await click(page, lang, "Sign in");
    await page.locator("#auth-email").fill(`user-${who}@example.test`);
    await click(page, lang, "Send sign-in email");
    await page.locator("#auth-code").fill("123456");
    await click(page, lang, "Verify code");
    await page.getByRole("button", { name: text(lang, "Sign out"), exact: true }).waitFor();
    await page.getByText(text(lang, "Saved to your account"), { exact: true }).first().waitFor();
  }
  async function create(page, ticker, lang = "en") {
    await click(page, lang, "Add Thesis");
    await page.locator("#ticker").fill(ticker);
    await page.locator("#statement").fill(lang === "zh" ? "我的增长观点依赖持续需求、按期执行和稳健利润率。" : "Growth depends on durable demand, timely execution and resilient margins.");
    await click(page, lang, "Find my Key Drivers →");
    await page.locator("#review-statement").waitFor();
    await click(page, lang, "Confirm Standing Thesis →");
    await page.getByRole("tab", { name: text(lang, "Overview"), exact: true }).waitFor();
  }
  async function evidence(page, lang = "en", quote = "  The timetable moved from September to December.\nOriginal source.  ") {
    await click(page, lang, "Add Evidence / Analyze Update");
    await page.locator("#information").fill("Timetable moved later");
    await page.locator("#source").fill("Controlled synthetic source");
    await page.locator("#source-text").fill(quote);
  }
  async function list(page, who = "a") {
    const response = await page.request.get(`${base}/api/workspaces`, { headers: { Authorization: `Bearer fixture-user-${who}` } });
    assert.equal(response.status(), 200);
    return (await response.json()).workspaces;
  }
  async function open(page, ticker, lang = "en") {
    await click(page, lang, "← My Theses");
    const tile = page.locator(".thesis-tile").filter({ has: page.getByRole("heading", { name: ticker, exact: true }) });
    // The ticker title is the card's single control.
    await tile.locator('[data-action="open"]').click();
  }
  try {
    const first = await context({ viewport: { width: 1440, height: 900 } });
    const page = await first.newPage();
    await page.goto(base);
    // A real existing anonymous flow supplies a supported migration artifact.
    await create(page, "LOCAL07");
    await evidence(page);
    await click(page, "en", "Analyze Update →");
    await page.locator('input[value="reject"]').check();
    await click(page, "en", "Apply human decision →");
    await page.locator(".action-panel").waitFor({ state: "hidden" });
    const original = await page.evaluate((key) => sessionStorage.getItem(key), storage);
    const localWorkspace = JSON.parse(original).workspaces[0];
    await signIn(page);
    await page.getByRole("heading", { name: "Import your browser session", exact: true }).waitFor();
    await page.route("**/api/workspaces/import", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "cloud_unavailable" } }) }));
    await click(page, "en", "Import this thesis");
    await page.getByRole("alert").waitFor();
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), storage), original);
    await page.unroute("**/api/workspaces/import");
    await click(page, "en", "Import this thesis");
    await page.getByRole("heading", { name: "Import your browser session", exact: true }).waitFor({ state: "hidden" });
    let imported = (await list(page)).find((item) => item.current_state.standing.ticker === "LOCAL07");
    assert.deepEqual(imported.current_state.standing, localWorkspace.standing);
    for (const [index, record] of localWorkspace.evidence.entries())
      for (const [key, value] of Object.entries(record)) {
        if (key === "content") {
          for (const [field, content] of Object.entries(value)) assert.deepEqual(imported.current_state.evidence[index].content[field], content);
        } else assert.deepEqual(imported.current_state.evidence[index][key], value);
      }
    assert.deepEqual(imported.current_state.versions, localWorkspace.versions);
    const repeated = await page.request.post(`${base}/api/workspaces/import`, { headers: { Authorization: "Bearer fixture-user-a" }, data: { workspace: localWorkspace, idempotency_key: "browser-repeat-import" } });
    assert.equal(repeated.status(), 200);
    assert.equal((await repeated.json()).id, imported.id);
    assert.equal((await list(page)).filter((item) => item.current_state.standing.ticker === "LOCAL07").length, 1);

    // The database returns the original idempotent outcome. A lost create
    // response followed by another device's v2 must never regress the UI to v1.
    let createFirstReply = true;
    const createKeys = [];
    await page.route("**/api/workspaces", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      createKeys.push(route.request().postDataJSON().idempotency_key);
      if (createFirstReply) {
        createFirstReply = false;
        const committed = await route.fetch();
        assert.equal(committed.status(), 200);
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "cloud_unavailable" } }) });
      }
      return route.continue();
    });
    await click(page, "en", "Add Thesis");
    await page.locator("#ticker").fill("RETRY07");
    await page.locator("#statement").fill("Growth depends on durable demand, timely execution and resilient margins.");
    await click(page, "en", "Find my Key Drivers →");
    await page.locator("#review-statement").waitFor();
    await click(page, "en", "Confirm Standing Thesis →");
    await page.getByRole("button", { name: "Reload my theses", exact: true }).waitFor();
    const createdElsewhere = (await list(page)).find((item) => item.current_state.standing.ticker === "RETRY07");
    const assessmentReply = await page.request.post(`${base}/api/workspaces/${createdElsewhere.id}/assess`, {
      headers: { Authorization: "Bearer fixture-user-a" },
      data: { evidence: { event_date: "2026-10-06", information: "Timetable moved later", source: "Controlled synthetic source", source_text: "The timetable moved from September to December." }, language: "en", expected_revision: createdElsewhere.revision, expected_thesis_version: 1, idempotency_key: "browser-create-other-assess" },
    });
    assert.equal(assessmentReply.status(), 200);
    const assessedElsewhere = await assessmentReply.json();
    const decisionReply = await page.request.post(`${base}/api/workspaces/${createdElsewhere.id}/decision`, {
      headers: { Authorization: "Bearer fixture-user-a" },
      data: { assessment_id: assessedElsewhere.current_state.pendingId, action: "accept", expected_revision: assessedElsewhere.revision, expected_thesis_version: 1, idempotency_key: "browser-create-other-decision" },
    });
    assert.equal(decisionReply.status(), 200);
    await click(page, "en", "Reload my theses");
    await page.getByRole("button", { name: "Reload my theses", exact: true }).waitFor({ state: "hidden" });
    await click(page, "en", "Confirm Standing Thesis →");
    await page.getByRole("tab", { name: "Overview", exact: true }).waitFor();
    assert.equal(await page.locator(".standing-card .pill").textContent(), "Standing v2");
    assert.equal(createKeys.length, 2);
    assert.equal(createKeys[0], createKeys[1]);
    assert.equal((await list(page)).filter((item) => item.current_state.standing.ticker === "RETRY07").length, 1);
    await page.unroute("**/api/workspaces");

    // Every human action works through the authoritative API in both layouts.
    for (const lang of ["en", "zh"]) {
      await page.setViewportSize(lang === "en" ? { width: 1440, height: 900 } : { width: 390, height: 844 });
      await page.getByRole("button", { name: lang === "en" ? "EN" : "中文", exact: true }).click();
      for (const action of ["accept", "edit", "reject", "keep_unresolved"]) {
        const ticker = `${lang.toUpperCase()}${action.slice(0, 3).toUpperCase()}07`;
        await create(page, ticker, lang);
        await evidence(page, lang);
        await click(page, lang, "Analyze Update →");
        await page.locator(`input[value="${action}"]`).check();
        if (action === "edit") await page.locator("#edited-statement").fill(lang === "zh" ? "我明确修改观点，保留需求与利润率，但执行时间表推迟。" : "My explicit revision retains demand and margins but delays execution timing.");
        // Simulate commit followed by a lost response; the same retry cannot
        // append a second decision or Standing version.
        let retryKeys = [];
        if (lang === "en" && action === "accept") {
          let firstReply = true;
          await page.route("**/api/workspaces/*/decision", async (route) => {
            retryKeys.push(route.request().postDataJSON().idempotency_key);
            if (firstReply) {
              firstReply = false;
              const committed = await route.fetch();
              assert.equal(committed.status(), 200);
              await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "cloud_unavailable" } }) });
            } else await route.continue();
          });
          await click(page, lang, "Apply human decision →");
          await page.getByRole("alert").first().waitFor();
        }
        await click(page, lang, "Apply human decision →");
        await page.locator(".action-panel").waitFor({ state: "hidden" });
        if (retryKeys.length) { assert.equal(retryKeys.length, 2); assert.equal(retryKeys[0], retryKeys[1]); await page.unroute("**/api/workspaces/*/decision"); }
        const saved = (await list(page)).find((item) => item.current_state.standing.ticker === ticker);
        assert.equal(saved.active_thesis_version, ["accept", "edit"].includes(action) ? 2 : 1);
        assert.equal(saved.current_state.decisions.length, 1);
        assert.equal(saved.current_state.versions.length, ["accept", "edit"].includes(action) ? 2 : 1);
        assert.equal(saved.current_state.evidence[0].content.source_text, "  The timetable moved from September to December.\nOriginal source.  ");
        assert.equal(saved.current_state.assessments[0].payload.driver_impacts[0].exact_quote, saved.current_state.evidence[0].content.source_text);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.reload();
        await page.getByRole("tab", { name: text(lang, "Overview"), exact: true }).waitFor();
      }
    }
    await page.getByRole("button", { name: "EN", exact: true }).click();
    // Server receipt rotation/expiry can be invisible to the browser clock.
    // It must offer exact-source reassessment, not reload the same unusable receipt.
    await create(page, "STALE07");
    await evidence(page);
    await click(page, "en", "Analyze Update →");
    await page.locator('input[value="accept"]').check();
    const beforeStale = (await list(page)).find((item) => item.current_state.standing.ticker === "STALE07");
    await page.route("**/api/workspaces/*/decision", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "stale_assessment" } }) }));
    await click(page, "en", "Apply human decision →");
    await page.getByRole("button", { name: "Analyze this evidence again", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Reload latest workspace", exact: true }).count(), 0);
    assert.equal(await page.locator('input[value="accept"]').count(), 0);
    await page.unroute("**/api/workspaces/*/decision");
    await page.reload();
    await page.getByRole("button", { name: "Analyze this evidence again", exact: true }).waitFor();
    await click(page, "en", "Analyze this evidence again");
    assert.equal(await page.locator("#source-text").inputValue(), beforeStale.current_state.evidence[0].content.source_text);
    await click(page, "en", "Analyze Update →");
    await page.locator('input[value="accept"]').check();
    await click(page, "en", "Apply human decision →");
    await page.locator(".action-panel").waitFor({ state: "hidden" });
    const afterStale = (await list(page)).find((item) => item.id === beforeStale.id);
    assert.equal(afterStale.active_thesis_version, 2);
    assert.equal(afterStale.current_state.decisions.length, 1);
    assert.equal(afterStale.current_state.assessments.length, 2);
    await click(page, "en", "Sign out");
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), storage), original);
    await signIn(page);
    assert.ok((await list(page)).some((item) => item.id === imported.id));

    const cleanContext = await context();
    const clean = await cleanContext.newPage();
    await clean.goto(base);
    await signIn(clean);
    await clean.getByRole("heading", { name: "LOCAL07", exact: true }).waitFor();
    assert.equal(await clean.evaluate((key) => JSON.parse(sessionStorage.getItem(key)).workspaces.length, storage), 0);

    // Two clean tabs start from one revision. A stale writer retains its draft
    // and must explicitly reload; successful writes are never lost.
    await open(page, "LOCAL07");
    const tile = clean.locator(".thesis-tile").filter({ has: clean.getByRole("heading", { name: "LOCAL07", exact: true }) });
    await tile.locator('[data-action="open"]').click();
    await evidence(clean, "en", "Another tab's retained draft source.");
    await evidence(page);
    await click(page, "en", "Analyze Update →");
    await page.locator('input[value="accept"]').waitFor();
    await click(clean, "en", "Analyze Update →");
    await clean.getByRole("button", { name: "Reload latest workspace", exact: true }).waitFor();
    assert.equal(await clean.locator("#source-text").inputValue(), "Another tab's retained draft source.");
    await click(clean, "en", "Reload latest workspace");
    assert.equal(await clean.locator("#source-text").inputValue(), "Another tab's retained draft source.");
    await click(clean, "en", "Analyze Update →");
    await clean.locator('input[value="accept"]').waitFor();

    // Signing out invalidates a delayed account response without resurrecting
    // the other user's workspace in the anonymous session.
    await evidence(clean);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await clean.route("**/api/workspaces/*/assess", async (route) => { await gate; await route.continue(); });
    await click(clean, "en", "Analyze Update →");
    await click(clean, "en", "Sign out");
    release();
    await clean.waitForTimeout(300);
    // Only the pinned Owner baseline card remains; no account workspace is resurrected.
    assert.equal(await clean.locator('.thesis-tile [data-action="open"]').count(), 0);
    await clean.unroute("**/api/workspaces/*/assess");

    const otherContext = await context();
    const other = await otherContext.newPage();
    await other.goto(base);
    await signIn(other, "en", "b");
    assert.equal((await list(other, "b")).length, 0);
    const denied = await other.request.get(`${base}/api/workspaces/${imported.id}`, { headers: { Authorization: "Bearer fixture-user-b" } });
    assert.ok([403, 404].includes(denied.status()));
    const anonymous = await other.request.get(`${base}/api/workspaces/${imported.id}`);
    assert.equal(anonymous.status(), 401);
    const beforeAnon = await page.evaluate((key) => sessionStorage.getItem(key), storage);
    await click(page, "en", "Clear local drafts");
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), storage), beforeAnon);
    assert.ok((await list(page)).some((item) => item.id === imported.id));
    assert.deepEqual(errors, []);
    console.log("Durable browser acceptance passed: persistence, bilingual actions, idempotent retry, migration, conflict, identity race and user isolation.");
  } catch (error) {
    console.error("Durable browser page errors:", errors);
    for (const value of contexts) for (const page of value.pages())
      console.error("Durable browser state:", await page.evaluate(() => ({
        language: document.documentElement.lang,
        buttons: [...document.querySelectorAll("button")].map((button) => button.textContent),
        fixtureSessionPresent: !!localStorage.getItem("fixture-auth-session"),
      })));
    throw error;
  } finally { for (const value of contexts) await value.close(); }
}
