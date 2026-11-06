import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { translate } from "../public/assets/i18n.js";
const replay = JSON.parse(readFileSync(new URL("../public/assets/replay-nvda.json", import.meta.url), "utf8"));
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }];

// The recorded real-filing replay: reachable from the baseline, static, and never a model call.
export async function replayChecks(browser, base, capture = async () => {}) {
  const run = replay.runs[0], scenario = replay.scenarios[0];
  for (const viewport of VIEWPORTS)
    for (const language of ["en", "zh"]) {
      const page = await browser.newPage({ viewport });
      const errors = [], posts = [];
      page.on("pageerror", e => errors.push(e.message));
      page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
      page.on("request", r => { if (r.method() !== "GET") posts.push(r.url()); });
      const text = key => translate(language, key);
      await page.goto(base);
      await page.getByRole("button", { name: language === "zh" ? "中文" : "EN", exact: true }).click();
      await page.locator('.baseline-tile [data-action="baseline"]').click();
      await page.getByRole("button", { name: text("View the recorded Historical Replay →"), exact: true }).click();
      await page.getByRole("heading", { name: text("Check for Updates, replayed on real NVIDIA filings"), exact: true }).waitFor();
      assert.equal(new URL(page.url()).hash, "#nvidia-replay");
      assert.equal(await page.locator(".replay-original .replay-event").count(), 2);
      const funnel = await page.locator(".standing-card .replay-funnel strong").allInnerTexts();
      assert.deepEqual(funnel, ["21", "19", "2", "1", "0"]);
      const relevant = page.locator(`.replay-original [data-event="edgar:0001045810-26-000078"]`);
      assert.equal(await relevant.locator(".card-top .pill.result").innerText(), text("Relevant"));     // as recorded
      assert.equal(await relevant.locator(".card-top .pill.superseded").innerText(), text("Superseded"));
      assert.equal(await page.locator('[data-event="edgar:0001104659-26-103913"] .card-top .pill.result').innerText(), text("Irrelevant"));
      assert.equal(await relevant.locator(".replay-decision strong").innerText(), text("Decision request withdrawn"));
      assert.equal(await page.getByText(text("Awaiting the Owner's decision"), { exact: true }).count(), 0);
      await page.locator(".replay-correction").waitFor();
      assert.equal(await relevant.locator(".replay-annotation").count(), replay.annotations.length);
      const reassessed = page.locator(".replay-reassessment .replay-event");
      assert.equal(await reassessed.locator(".card-top .pill.result").innerText(), text("Driver context only"));
      const t0 = page.locator(`.replay-scenario[data-scenario="${scenario.id}"]`);
      await t0.getByText(text("HISTORICAL T0 SCENARIO · NOT THE OWNER'S THESIS"), { exact: true }).waitFor();
      assert.equal(await t0.locator(".card-top .pill.result").innerText(), text("Watch Item evidence"));
      assert.equal(await t0.locator(".replay-decision strong").innerText(), text("Scenario only"));
      const source = await relevant.locator('a[target="_blank"]').first().evaluate(a => [a.href, a.rel]);
      assert.equal(source[0], "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000078/nvda-20260902.htm");
      assert.match(source[1], /noopener/);
      // A recorded quote is shown verbatim.
      const quote = run.events.find(e => e.accession === "0001045810-26-000078").what_changed.driver_impacts[0].exact_quote;
      assert.ok((await relevant.locator("blockquote").allInnerTexts()).includes(quote));
      await page.locator(".replay-original .replay-noise summary").click();
      assert.equal(await page.locator(".replay-original .replay-noise li").count(), 19);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${language} ${viewport.width}`);
      await capture(page, `replay-${language}-${viewport.width}`);
      await page.reload();
      await page.getByRole("heading", { name: text("Check for Updates, replayed on real NVIDIA filings"), exact: true }).waitFor();
      await page.getByRole("button", { name: text("← NVIDIA Standing Thesis"), exact: true }).click();
      await page.getByRole("heading", { name: text("NVIDIA Standing Thesis"), exact: true }).waitFor();
      assert.deepEqual(posts, []);       // replay viewing makes no model or API mutation call
      assert.deepEqual(errors, []);
      await page.close();
    }
  // A direct link works on a fresh session.
  const page = await browser.newPage();
  await page.goto(`${base}#nvidia-replay`);
  await page.locator(".replay-event").first().waitFor();
  await page.close();
  console.log("Replay browser acceptance passed: EN/ZH × 1440/1024/768/390, recorded runs, correction, annotations, reassessment, labelled T0 scenario, 0 non-GET requests.");
}
