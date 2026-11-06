import assert from "node:assert/strict";
import { translate } from "../public/assets/i18n.js";
const text = (lang, key) => translate(lang, key);
export async function customChecks(browser, base, capture = async () => {}) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ])
    for (const lang of ["en", "zh"])
      for (const action of ["accept", "edit", "reject", "keep_unresolved"]) {
        const page = await browser.newPage({ viewport });
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on("pageerror", (err) => errors.push(err.message));
        const click = (key) =>
          page
            .getByRole("button", { name: text(lang, key), exact: true })
            .last()
            .click();
        const stored = () =>
          page.evaluate(() =>
            JSON.parse(sessionStorage.getItem("living-thesis-hosted-v061")),
          );
        const authored =
          lang === "zh"
            ? "我的观点是增长依赖持续需求、按期执行和稳健利润率。"
            : "My thesis depends on durable demand, timely execution and resilient margins.";
        const quote =
          "  The timetable  moved from September to December.\nOriginal source quotation.  ";
        await page.goto(base);
        await page
          .getByRole("button", {
            name: lang === "zh" ? "中文" : "EN",
            exact: true,
          })
          .click();
        await click("Add Thesis");
        await page.locator("#ticker").fill("TEST");
        await page.locator("#statement").fill(authored);
        await click("Find my Key Drivers →");
        await page.locator("#review-statement").waitFor();
        assert.equal((await stored()).workspaces.length, 0);
        await page.reload();
        if (action === "accept")
          await capture(page, `custom-${lang}-${viewport.width}-creation`);
        await click("Confirm Standing Thesis →");
        const before = (await stored()).workspaces[0].standing;
        assert.equal((await stored()).workspaces[0].authored, authored);
        if (lang === "zh") assert.equal(before.drivers[0].title, "需求持续性");
        await click("Add Evidence / Analyze Update");
        await page.locator("#information").fill("Timetable moved later");
        await page.locator("#source").fill("Controlled synthetic source");
        await page.locator("#source-text").fill(quote);
        await click("Analyze Update →");
        await page
          .getByRole("radio", { name: new RegExp("^" + text(lang, "Accept")) })
          .waitFor();
        let record = (await stored()).workspaces[0];
        assert.deepEqual(record.standing, before);
        assert.equal(
          record.assessments[0].payload.driver_impacts[0].exact_quote,
          quote,
        );
        assert.equal(record.evidence[0].sourceVerified, false);
        if (lang === "zh")
          assert.match(record.assessments[0].payload.reasoning, /合成来源/);
        if (action === "accept")
          await capture(page, `custom-${lang}-${viewport.width}-assessment`);
        await page.reload();
        await page.locator(`input[name="decision"][value="${action}"]`).check();
        if (action === "edit")
          await page
            .locator("#edited-statement")
            .fill(
              lang === "zh"
                ? "我明确修订为执行时间表推迟，但需求与利润率假设保留。"
                : "My explicit revision keeps demand and margin assumptions but delays execution.",
            );
        assert.deepEqual((await stored()).workspaces[0].standing, before);
        await click("Apply human decision →");
        await page.locator(".action-panel").waitFor({ state: "hidden" });
        record = (await stored()).workspaces[0];
        assert.equal(
          record.standing.version,
          ["accept", "edit"].includes(action) ? 2 : 1,
        );
        assert.equal(record.decisions[0].action, action);
        assert.equal(record.history.at(-1).type, "decision");
        if (action === "accept")
          await capture(page, `custom-${lang}-${viewport.width}-workspace`);
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
        await page
          .getByRole("tab", { name: text(lang, "History"), exact: true })
          .click();
        await page.reload();
        assert.equal((await stored()).workspaces[0].decisions.length, 1);
        assert.deepEqual(errors, []);
        await page.close();
        console.log(`Custom ${lang} ${viewport.width} ${action} passed`);
      }
}
