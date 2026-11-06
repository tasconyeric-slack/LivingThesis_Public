import assert from "node:assert/strict";
import { translate } from "../public/assets/i18n.js";
export async function demoChecks(browser, base, capture = async () => {}) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ])
    for (const lang of ["en", "zh"])
      for (const action of ["accept", "edit", "reject", "keep_unresolved"]) {
        const page = await browser.newPage({ viewport });
        page.setDefaultTimeout(12000);
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        const text = (key) => translate(lang, key),
          click = (key) =>
            page
              .getByRole("button", { name: text(key), exact: true })
              .last()
              .click();
        const stored = () =>
          page.evaluate(() =>
            JSON.parse(sessionStorage.getItem("living-thesis-hosted-v061")),
          );
        await page.goto(base);
        await page
          .getByRole("button", {
            name: lang === "zh" ? "中文" : "EN",
            exact: true,
          })
          .click();
        // The demo is an inline link in the intro, not a button competing with the NVIDIA card.
        await page.locator('[data-action="demo"]').click();
        await page
          .getByRole("tab", { name: text("Overview"), exact: true })
          .waitFor();
        const before = (await stored()).workspaces[0].standing;
        if (lang === "zh")
          assert.equal(before.drivers[1].title, "Rubin 量产执行");
        await click("Add Evidence / Analyze Update");
        await click("Office furniture update");
        await page
          .getByText(
            text(
              "0 drivers · 0 research questions · 0 provider or model calls.",
            ),
            { exact: true },
          )
          .waitFor();
        assert.deepEqual((await stored()).workspaces[0].standing, before);
        assert.equal(
          await page.locator('input[value="accept"]').isDisabled(),
          true,
        );
        await click("Add Evidence / Analyze Update");
        await click("Rubin timetable delayed");
        await page
          .getByText(
            text(
              "1 of 4 drivers · 2 of 6 research questions revisited. Other research retained.",
            ),
            { exact: true },
          )
          .waitFor();
        const a = (await stored()).workspaces[0].assessments.at(-1);
        assert.deepEqual(
          a.payload.driver_impacts.map((i) => i.driver_id),
          ["T1.D2"],
        );
        assert.equal(
          a.payload.driver_impacts[0].exact_quote,
          "Synthetic Rubin timetable was revised from September to December.",
        );
        if (action === "accept")
          await capture(page, `demo-${lang}-${viewport.width}-assessment`);
        await page.reload();
        await page.locator(`input[value="${action}"]`).check();
        if (action === "edit")
          await page
            .locator("#edited-statement")
            .fill(
              lang === "zh"
                ? "我决定保留需求假设，并更新 Rubin 执行时间表。"
                : "My human decision retains demand and revises the Rubin execution timetable.",
            );
        assert.deepEqual((await stored()).workspaces[0].standing, before);
        await click("Apply human decision →");
        await page.locator(".action-panel").waitFor({ state: "hidden" });
        assert.equal(
          (await stored()).workspaces[0].standing.version,
          ["accept", "edit"].includes(action) ? 2 : 1,
        );
        if (action === "accept")
          await capture(page, `demo-${lang}-${viewport.width}-workspace`);
        await page
          .getByRole("tab", { name: text("Overview"), exact: true })
          .focus();
        await page.keyboard.press("ArrowRight");
        assert.equal(
          await page
            .getByRole("tab", { name: text("Evidence"), exact: true })
            .getAttribute("aria-selected"),
          "true",
        );
        await page.keyboard.press("End");
        assert.equal(
          await page
            .getByRole("tab", { name: text("History"), exact: true })
            .getAttribute("aria-selected"),
          "true",
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
        assert.deepEqual(errors, []);
        await page.close();
        console.log(`Demo ${lang} ${viewport.width} ${action} passed`);
      }
}
