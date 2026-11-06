import test from "node:test";
import assert from "node:assert/strict";
import { verifyCloud } from "../cloud-preflight.mjs";

const config = { SUPABASE_URL: "https://provider.example.test", SUPABASE_SECRET_KEY: "server-only-test-key", SUPABASE_PUBLISHABLE_KEY: "public-test-key" };
test("Production cannot deploy without complete provider configuration", async () => {
  await assert.rejects(verifyCloud({ VERCEL_ENV: "production" }), /Incomplete cloud configuration/);
  await assert.rejects(verifyCloud({ ...config, SUPABASE_PUBLISHABLE_KEY: "" }), /Incomplete cloud configuration/);
  await verifyCloud({}); // Credential-free CI/local static build retains anonymous workflows.
});
test("Provider builds require exact installed schema before SDK or app output", async () => {
  for (const value of [null, "1", 0, 2])
    await assert.rejects(verifyCloud(config, async () => ({ ok: true, json: async () => value })), /schema v1 is not ready/);
  await assert.rejects(verifyCloud(config, async () => { throw new Error("sensitive upstream details"); }), /schema v1 is not ready/);
  await verifyCloud(config, async (url, options) => {
    assert.equal(url, config.SUPABASE_URL + "/rest/v1/rpc/v07_schema_version");
    assert.equal(options.headers.apikey, config.SUPABASE_SECRET_KEY);
    return { ok: true, json: async () => 1 };
  });
});
