import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("CSP defaults to self until a deployment adds its own Supabase origin", async () => {
  const config = JSON.parse(await readFile(new URL("../../vercel.json", import.meta.url), "utf8"));
  const csp = config.headers.find((rule) => rule.source === "/(.*)").headers
    .find((header) => header.key === "Content-Security-Policy").value;
  const directives = Object.fromEntries(csp.split(";").map((value) => value.trim().split(/\s+/))
    .filter(([name]) => name).map(([name, ...values]) => [name, values]));
  assert.deepEqual(directives["connect-src"], ["'self'"]);
  assert.deepEqual(directives["script-src"], ["'self'"]);
  assert.deepEqual(directives["frame-ancestors"], ["'none'"]);
});
