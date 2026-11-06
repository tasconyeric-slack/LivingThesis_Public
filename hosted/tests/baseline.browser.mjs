import assert from "node:assert/strict";
import { translate } from "../public/assets/i18n.js";
import { baseline, standingFromBaseline } from "../public/assets/baseline.js";
const FALSIFIERS = ["D1.F1", "D1.F2", "D2.F1", "D3.F1", "D3.F2", "D3.F3", "D4.F1", "D5.F1"];
const WATCHES = ["W1.1", "W1.2", "W1.3", "W1.4", "W2.1", "W2.2", "W3.1", "W3.2", "W3.3", "W3.4", "W4.1", "W5.1", "W5.2"];
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];
const overflows = page => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

async function start(browser, base, viewport, language) {
  const page = await browser.newPage({ viewport });
  const errors = [], mutations = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", request => { if (request.method() === "POST") mutations.push(request.url()); });
  const text = (key, params) => translate(language, key, params);
  const ctx = { page, errors, mutations, text,
    click: key => page.getByRole("button", { name: text(key), exact: true }).last().click(),
    stored: () => page.evaluate(() => JSON.parse(sessionStorage.getItem("living-thesis-hosted-v061"))) };
  await page.goto(base);
  await page.getByRole("button", { name: language === "zh" ? "中文" : "EN", exact: true }).click();
  await page.getByRole("heading", { name: text("Let new information test your investment thesis."), exact: true }).waitFor();
  return ctx;
}
// Read the baseline, explicitly adopt it as the investor's own NVDA workspace, and return the adopted Standing.
async function adopt({ page, text, click, stored, mutations }, language) {
  // From the home list the pinned card is the single way in; a reload may already be on the baseline page.
  if (await page.locator('.baseline-tile [data-action="baseline"]').count())
    await page.locator('.baseline-tile [data-action="baseline"]').click();
  await page.getByRole("heading", { name: text("NVIDIA Standing Thesis"), exact: true }).waitFor();
  await click("Review and use this thesis →");
  assert.equal(await page.locator(".edit-driver").count(), 5);
  assert.deepEqual((await stored()).workspaces, []);
  await click("Confirm Standing Thesis →");
  await page.getByRole("tab", { name: text("Overview"), exact: true }).waitFor();
  const before = (await stored()).workspaces[0].standing;
  assert.deepEqual(before, standingFromBaseline(language));
  assert.equal(before.falsifiers.length, 8);
  assert.deepEqual(mutations, []); // Adopting an authored baseline makes no model run.
  return before;
}
async function analyze({ page, text, click, stored }, before) {
  await click("Add Evidence / Analyze Update");
  await page.locator("#information").fill("Hypothetical QA evidence of a delivery delay; not an actual NVIDIA event.");
  await page.locator("#source").fill("Synthetic browser QA fixture");
  await page.locator("#source-text").fill("Hypothetical QA only: a previously stated delivery milestone moves to the next quarter.");
  await click("Analyze Update →");
  await page.locator('input[value="keep_unresolved"]').waitFor();
  // The AI proposal is not the Standing Thesis: nothing changes until a human decides.
  assert.deepEqual((await stored()).workspaces[0].standing, before);
}

export async function baselineChecks(browser, base, capture = async () => {}) {
  for (const viewport of VIEWPORTS)
    for (const language of ["en", "zh"]) {
      const ctx = await start(browser, base, viewport, language);
      const { page, errors, mutations, text, click, stored } = ctx;
      const note = text("Signed-in investors who adopt the Owner-approved NVIDIA baseline can run Check for Updates on NVIDIA's SEC filings on demand. Otherwise, explore the workflow with the {demo} or evidence you provide manually; manually supplied sources are not independently verified.", { demo: text("synthetic demo") });
      await page.getByText(note, { exact: true }).waitFor();
      assert.equal(await page.locator('[data-action="demo"]').count(), 1);
      assert.equal(await page.locator(".value-steps li").count(), 3);
      // No competing doors: one create action (header), the intro's only control is the
      // demo link, and the pinned NVIDIA card is the single way into the baseline.
      assert.equal(await page.locator('[data-action="create"]').count(), 1);
      assert.equal(await page.locator(".product-intro button").count(), 1);
      assert.equal(await page.locator('[data-action="baseline"]').count(), 1);
      assert.equal(await page.locator('.baseline-tile [data-action="open"]').count(), 0);
      await page.getByText(text("{count} of {total} falsifiers have monitoring gaps", { count: 7, total: 8 }), { exact: true }).waitFor();
      await page.getByText(text("Owner baseline · read-only"), { exact: true }).waitFor();
      // Owner decision 6: the no-valuation / no-buy-sell caveat is stated on the card, apart from the statement.
      assert.equal(await page.locator('.baseline-tile [data-notice="NOT_ADVICE"]').innerText(), baseline.notices[0].text[language]);
      assert.equal(await page.locator(".baseline-tile .thesis-text").innerText(), baseline.statement[language]);
      assert.equal(await overflows(page), false);
      await capture(page, `baseline-${language}-${viewport.width}-home`);

      await page.locator('.baseline-tile [data-action="baseline"]').click();
      await page.getByRole("heading", { name: text("NVIDIA Standing Thesis"), exact: true }).waitFor();
      // Five drivers, eight conditions, thirteen Watch Items, all visible with their approved identities.
      assert.equal(await page.locator(".baseline-drivers .driver-card").count(), 5);
      assert.equal(await page.locator(".monitor-row").count(), 8);
      for (const id of FALSIFIERS) await page.getByRole("heading", { name: id, exact: true }).waitFor();
      for (const id of WATCHES) assert.equal(await page.locator(".baseline-drivers strong", { hasText: new RegExp(`^${id.replace(".", "\\.")}$`) }).count(), 1, id);
      assert.equal(await page.getByText(text("Partial coverage · monitoring gap"), { exact: true }).count(), 4);
      assert.equal(await page.getByText(text("Monitoring gap · no source mapping"), { exact: true }).count(), 3);
      assert.equal(await page.getByText(text("Disclosed facts only"), { exact: true }).count(), 1);
      // The eight Watch Items NVIDIA's own documents cannot observe are explicit gaps, in the cards and in the map.
      assert.equal(await page.locator(".baseline-drivers .gap-note").count(), 8);
      assert.equal(await page.locator(".monitor-row .gap-note").count(), 8);
      assert.equal(await page.getByText(text("Mid-weak signal"), { exact: true }).count(), 2);
      assert.equal(await page.getByText(text("Weak signal"), { exact: true }).count(), 2);
      // The approved statement is shown exactly as approved; the caveat is a separate note beneath it (Owner decision 6).
      assert.equal(await page.locator(".standing-card .thesis-text").innerText(), baseline.statement[language]);
      assert.equal(await page.locator('.standing-card [data-notice="NOT_ADVICE"]').innerText(), baseline.notices[0].text[language]);
      // Owner decision 2: one dated, cited, read-only context note, inside D5 only, with NVIDIA's sentence verbatim.
      const ctxNote = page.locator(".baseline-drivers .driver-card .context-note");
      assert.equal(await page.locator(".context-note").count(), 1);
      assert.equal(await ctxNote.count(), 1);
      assert.match(await page.locator(".baseline-drivers .driver-card", { has: page.locator(".context-note") }).locator("h3").innerText(), /^D5 · /);
      assert.equal(await ctxNote.locator("blockquote").innerText(), baseline.contextNotes[0].parts[0].quote);
      assert.equal(await ctxNote.locator("dt").count(), 4);
      assert.equal(await ctxNote.locator("button, [data-action]").count(), 0);
      assert.equal(await ctxNote.locator(".pill").innerText(), text("Owner-approved baseline"));
      const [href, target, rel] = await ctxNote.locator('a[target="_blank"]').evaluate(a => [a.href, a.target, a.rel]);
      assert.deepEqual([href, target, /noopener/.test(rel)], [baseline.contextNotes[0].citation.url, "_blank", true]);
      await ctxNote.getByText("2026-08-26").first().waitFor();
      // The falsifier is neither declared triggered nor declared safe.
      await ctxNote.getByText(baseline.contextNotes[0].parts[3].text[language], { exact: true }).waitFor();
      assert.equal(await ctxNote.getByText(/D5\.F1 (is )?(has )?triggered|已触发 D5/).count(), 0);
      assert.equal(await overflows(page), false);
      await ctxNote.scrollIntoViewIfNeeded();
      await capture(page, `baseline-${language}-${viewport.width}-context-note`);
      // The Owner's approval of this exact hash is recorded and shown; nothing is pending and nothing claims the old "confirmed".
      assert.equal(await page.locator(".standing-card > .card-top .pill").innerText(), text("Owner-approved baseline"));
      assert.equal(await page.getByText(/Pending Owner approval|待 Owner 批准|Owner-confirmed|Owner 已确认/).count(), 0);
      // Approved content keeps its historical date; the 10-Q carries its EDGAR filing date.
      await page.getByText(new RegExp(`${text("Approved content as of")}: 2026-10-07`)).waitFor();
      await page.getByText(`NVDA_Q2FY2027_10Q · ${text("Filed / published")} 2026-08-26`, { exact: true }).waitFor();
      assert.equal(await page.getByText("2026-08-27").count(), 0);
      const links = await page.locator(".baseline-sources a").evaluateAll(items => items.map(a => [a.href, a.target, a.rel]));
      assert.deepEqual(links.map(([href]) => href), baseline.sources.map(s => s.url));
      assert.ok(links.every(([, target, rel]) => target === "_blank" && /noopener/.test(rel)));
      // The provenance record shows both full hashes, and the page still fits with it open.
      await page.locator(".provenance summary").click();
      await page.getByText(`SHA-256 ${baseline.provenance.contentSha256}`, { exact: true }).waitFor();
      await page.getByText(`SHA-256 ${baseline.provenance.approvedArtifact.contentSha256}`, { exact: true }).waitFor();
      assert.equal(await overflows(page), false);
      assert.deepEqual((await stored()).workspaces, []);
      assert.deepEqual(mutations, []);
      await capture(page, `baseline-${language}-${viewport.width}-thesis`);
      await page.reload();
      await page.getByRole("heading", { name: text("NVIDIA Standing Thesis"), exact: true }).waitFor();

      // Adoption, evidence and an explicit decision.
      const before = await adopt(ctx, language);
      assert.equal(await page.locator(".monitor-row").count(), 8);
      assert.equal(await page.locator(".overview-aside .summary-card", { has: page.getByRole("heading", { name: text("Falsifiers"), exact: true }) }).locator("li").count(), 8);
      // One workspace per ticker: the baseline card has become the investor's own NVDA card.
      await click("← My Theses");
      assert.equal(await page.locator(".baseline-tile").count(), 0);
      assert.equal(await page.locator('.thesis-tile [data-action="open"]').count(), 1);
      // A stale baseline link opens the owned workspace; there is no second adoption path.
      await page.goto(`${base}#nvidia-baseline`);
      await page.reload();
      await page.getByRole("tab", { name: text("Overview"), exact: true }).waitFor();
      assert.equal((await stored()).workspaces.length, 1);
      await page.reload();
      await analyze(ctx, before);
      await page.locator('input[value="keep_unresolved"]').check();
      await click("Apply human decision →");
      await page.locator(".action-panel").waitFor({ state: "hidden" });
      assert.deepEqual((await stored()).workspaces[0].standing, before);
      assert.equal((await stored()).workspaces[0].decisions.at(-1).action, "keep_unresolved");
      // The synthetic demo never takes over the NVDA ticker: both coexist, real card first.
      await click("← My Theses");
      await page.locator('[data-action="demo"]').click();
      await page.getByRole("tab", { name: text("Overview"), exact: true }).waitFor();
      await click("← My Theses");
      assert.deepEqual(await page.locator(".thesis-tile h2").allTextContents(), ["NVDA", text("NVIDIA demo")]);
      assert.equal((await stored()).workspaces.length, 2);
      assert.equal(await overflows(page), false);
      assert.deepEqual(errors, []);
      await page.close();
      console.log(`Baseline ${language} ${viewport.width} 5/8/13, gaps, adoption and Keep unresolved passed`);

      // The other three explicit decisions on the adopted 8-condition Standing.
      for (const action of ["accept", "edit", "reject"]) {
        const run = await start(browser, base, viewport, language);
        const standing = await adopt(run, language);
        await analyze(run, standing);
        await run.page.locator(`input[name="decision"][value="${action}"]`).check();
        if (action === "edit")
          await run.page.locator("#edited-statement").fill(language === "zh"
            ? "我明确修订为执行时间表可能推迟，其余假设与证伪条件保持不变。"
            : "My explicit revision allows for later execution; every other assumption and condition is unchanged.");
        assert.deepEqual((await run.stored()).workspaces[0].standing, standing);
        await run.click("Apply human decision →");
        await run.page.locator(".action-panel").waitFor({ state: "hidden" });
        const record = (await run.stored()).workspaces[0];
        assert.equal(record.decisions.at(-1).action, action);
        assert.equal(record.standing.version, action === "reject" ? 1 : 2);
        // Only the thesis statement may change, and only by the human's decision.
        assert.deepEqual(record.standing.drivers, standing.drivers);
        assert.deepEqual(record.standing.falsifiers, standing.falsifiers);
        assert.equal(record.standing.falsifiers.length, 8);
        assert.equal(await overflows(run.page), false);
        assert.deepEqual(run.errors, []);
        await run.page.close();
        console.log(`Baseline ${language} ${viewport.width} ${action} on the adopted 8-condition Standing passed`);
      }
    }
}
