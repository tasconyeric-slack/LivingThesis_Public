import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { baselineChecks } from "./baseline.browser.mjs";
import { replayChecks } from "./replay.browser.mjs";
import { demoChecks } from "./demo.browser.mjs";
import { customChecks } from "./custom.browser.mjs";
import { recoveryChecks } from "./recovery.browser.mjs";
import { durableChecks } from "./durable.browser.mjs";
import { checkFlowChecks } from "./checks.browser.mjs";
const python =
  process.env.E2E_PYTHON ||
  (process.platform === "win32"
    ? ".venv-hosted/Scripts/python.exe"
    : ".venv-hosted/bin/python");
const base = process.env.BASE_URL || "http://127.0.0.1:3416";
const fixtureBase = "http://127.0.0.1:3417";
const durableBase = "http://127.0.0.1:3418";
const children = [];
function server(args) {
  const child = spawn(python, args, {
    stdio: "ignore",
    env: { ...process.env, DEEPSEEK_API_KEY: "" },
  });
  child.on("error", (err) => console.error(err.message));
  children.push(child);
}
async function ready(url) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url + "/api/health")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Server not ready: " + url);
}
async function capture(page, name) {
  if (process.env.CAPTURE_SCREENSHOTS !== "1") return;
  mkdirSync("docs/v061", { recursive: true });
  await page.screenshot({ path: `docs/v061/${name}.png`, fullPage: true });
}
let browser;
try {
  if (!process.env.BASE_URL)
    server([
      "-m",
      "uvicorn",
      "api.index:app",
      "--host",
      "127.0.0.1",
      "--port",
      "3416",
    ]);
  server(["hosted/tests/browser_fixture.py", "3417"]);
  server(["hosted/tests/durable_browser_fixture.py", "3418"]);
  await Promise.all([ready(base), ready(fixtureBase), ready(durableBase)]);
  browser = await chromium.launch(
    process.env.BROWSER_EXECUTABLE
      ? { executablePath: process.env.BROWSER_EXECUTABLE }
      : {},
  );
  await baselineChecks(browser, fixtureBase, capture);
  await replayChecks(browser, fixtureBase, capture);
  await demoChecks(browser, base, capture);
  await customChecks(browser, fixtureBase, capture);
  await recoveryChecks(
    browser,
    fixtureBase,
    process.env.BASE_URL ? null : base,
    capture,
  );
  console.log(
    "v0.6.1 browser acceptance passed: 32 bilingual desktop/mobile decision flows plus recovery, race, isolation, export and escaping checks.",
  );
  const fixtureUsers = {
    a: "11111111-1111-4111-8111-111111111111",
    b: "22222222-2222-4222-8222-222222222222",
  };
  await durableChecks(browser, durableBase, fixtureUsers);
  await checkFlowChecks(browser, durableBase, fixtureUsers);
} finally {
  if (browser) await browser.close();
  for (const child of children) child.kill();
}
