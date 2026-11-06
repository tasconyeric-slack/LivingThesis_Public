import { access, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { verifyCloud } from "./cloud-preflight.mjs";
import { baseline, validateBaseline } from "./public/assets/baseline.js";
import { contentSha256 } from "./baseline-artifact.mjs";
validateBaseline();
// A deployed build must carry exactly the baseline content that its provenance record names.
const baselineSha256 = contentSha256(baseline);
if (baselineSha256 !== baseline.provenance.contentSha256) throw new Error("Baseline content does not match its recorded provenance hash");
const revision = process.env.COMMIT_REF || process.env.VERCEL_GIT_COMMIT_SHA || (await promisify(execFile)("git", ["rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid build commit identity");
await writeFile(new URL("public/assets/build-info.json", import.meta.url), JSON.stringify({
  version: "0.7.1", revision, baselineId: baseline.id,
  baselineContentSha256: baselineSha256, baselineStatus: baseline.provenance.status,
}) + "\n");
// Provision/schema comes before application deployment. Never print credentials.
await verifyCloud();
await build({entryPoints: [fileURLToPath(new URL("auth-sdk.mjs", import.meta.url))],
  outfile: fileURLToPath(new URL("public/assets/supabase.js", import.meta.url)),
  bundle: true, format: "esm", platform: "browser", minify: true, target: "es2022"});
for (const file of [
  "index.html",
  "assets/app.js",
  "assets/product.js",
  "assets/baseline.js",
  "assets/baseline-view.js",
  "assets/replay-view.js",
  "assets/check-view.js",
  "assets/replay-nvda.json",
  "assets/build-info.json",
  "assets/session.js",
  "assets/cloud.js",
  "assets/supabase.js",
  "assets/i18n.js",
  "assets/demo.json",
  "assets/demo-zh.json",
  "assets/style.css",
]) {
  await access(new URL(`public/${file}`, import.meta.url));
}
const html = await readFile(
  new URL("public/index.html", import.meta.url),
  "utf8",
);
if (!html.includes("Living Investment Thesis"))
  throw new Error("Missing product entrypoint");
console.log("Hosted product ready. Cloud requires verified identity and schema v1.");
