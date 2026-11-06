import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshSession, createWorkspace } from "../public/assets/session.js";
import { hydrateWorkspace, newestWorkspace, importCandidates, importConflict, MutationKeys, connectCloud } from "../public/assets/cloud.js";
const standing = JSON.parse(readFileSync(new URL("../public/assets/demo.json", import.meta.url))).standing;
const workspace = createWorkspace(freshSession(), {
  id: "local", standing, authored: "Exact authored thesis", language: "en", time: null,
}).workspaces[0];
const wrapper = {
  id: "server", revision: 3, active_thesis_version: 1,
  current_state: workspace, created_at: "2026-10-06", updated_at: "2026-10-06", archived_at: null,
};
test("cloud hydration keeps authoritative artifacts and only recovers transient drafts", () => {
  const value = hydrateWorkspace(wrapper, { standing: { statement: "Stale" }, draft: { evidence: { source_text: "Retained draft" } }, action: "evidence", error: "old" });
  assert.deepEqual(value.standing, standing);
  assert.equal(value.id, "server");
  assert.equal(value.cloudRevision, 3);
  assert.equal(value.draft.evidence.source_text, "Retained draft");
  assert.equal(value.action, "evidence");
  assert.equal(value.error, "");
  value.standing.statement = "Independent copy";
  assert.equal(wrapper.current_state.standing.statement, standing.statement);
});
test("cloud hydration rejects bad revisions and inconsistent Standing metadata", () => {
  for (const bad of [{ ...wrapper, revision: 0 }, { ...wrapper, active_thesis_version: 2 }, { ...wrapper, current_state: { ...workspace, history: null } }])
    assert.throws(() => hydrateWorkspace(bad), /invalid_cloud_state/);
});
test("server-rejected receipts remain stale across reload of the same pending assessment", () => {
  const pending = { ...wrapper, current_state: { ...workspace, pendingId: "assessment-one" } };
  const previous = { staleAssessmentId: "assessment-one" };
  assert.equal(hydrateWorkspace(pending, previous).error, "stale_assessment");
  assert.equal(hydrateWorkspace({ ...pending, current_state: { ...pending.current_state, pendingId: "assessment-two" } }, previous).error, "");
});
test("original create or mutation retry outcomes cannot regress a newer known revision", () => {
  const latest = hydrateWorkspace({ ...wrapper, revision: 6 });
  assert.equal(newestWorkspace(wrapper, latest), latest);
  const archived = { ...latest, cloudArchived: "2026-10-06" };
  assert.equal(newestWorkspace(wrapper, archived), archived);
  assert.equal(newestWorkspace({ ...wrapper, revision: 7 }, latest).cloudRevision, 7);
});
test("import preview excludes demos and already confirmed imports without changing local state", () => {
  const local = { ...freshSession(), workspaces: [workspace, { ...workspace, id: "demo", mode: "demo" }] };
  const before = structuredClone(local);
  assert.deepEqual(importCandidates(local).map((item) => item.id), ["local"]);
  assert.deepEqual(importCandidates(local, { local: "server" }), []);
  assert.deepEqual(local, before);
});
test("a local thesis cannot be imported next to the account's workspace for the same ticker", () => {
  const account = [hydrateWorkspace(wrapper)];
  assert.equal(importConflict(workspace, account), true);
  assert.equal(importConflict({ ...workspace, standing: { ...standing, ticker: " nvda " } }, account), true);
  assert.equal(importConflict({ ...workspace, standing: { ...standing, ticker: "MSFT" } }, account), false);
  assert.equal(importConflict(workspace, []), false);
  // The synthetic demo never counts as the account's real workspace.
  assert.equal(importConflict(workspace, [{ ...account[0], mode: "demo" }]), false);
});
test("mutation retries retain their key across recovery but changed payloads never reuse it", () => {
  let sequence = 0;
  const keys = new MutationKeys(() => String(++sequence));
  assert.equal(keys.key("assess:one", { source: "exact" }), "1");
  assert.equal(keys.key("assess:one", { source: "exact" }), "1");
  const recovered = new MutationKeys(() => String(++sequence));
  recovered.restore(keys.snapshot());
  assert.equal(recovered.key("assess:one", { source: "exact" }), "1");
  assert.equal(recovered.key("assess:one", { source: "changed" }), "2");
  recovered.complete("assess:one");
  assert.equal(recovered.key("assess:one", { source: "changed" }), "3");
});
test("only the exact unfinished request counts as a retry, so a changed or finished create is not one", () => {
  const keys = new MutationKeys(() => "k");
  assert.equal(keys.retrying("create", { ticker: "NVDA" }), false);
  keys.key("create", { ticker: "NVDA" });
  assert.equal(keys.retrying("create", { ticker: "NVDA" }), true);
  assert.equal(keys.retrying("create", { ticker: "NVDA", edited: true }), false);
  assert.equal(keys.retrying("assess:one", { ticker: "NVDA" }), false);
  keys.complete("create");
  assert.equal(keys.retrying("create", { ticker: "NVDA" }), false);
});
test("unavailable auth config never loads a provider SDK", async () => {
  let loaded = false;
  assert.equal(await connectCloud(() => {}, {
    origin: "http://fixture", fetcher: async () => ({ ok: true, json: async () => ({ available: false }) }),
    loadSdk: async () => { loaded = true; },
  }), null);
  assert.equal(loaded, false);
});
test("official auth adapter requests email sign-in and authenticated no-store API calls", async () => {
  const calls = [], session = { access_token: "fixture-token", user: { id: "fixture-user" } };
  const auth = {
    onAuthStateChange() {}, getSession: async () => ({ data: { session } }),
    signInWithOtp: async (body) => { calls.push(body); return {}; },
    verifyOtp: async (body) => { calls.push(body); return {}; }, signOut: async () => ({}),
  };
  const value = await connectCloud(() => {}, {
    origin: "http://fixture", loadSdk: async () => ({ createClient: (_url, _key, options) => { assert.equal(options.auth.detectSessionInUrl, true); return { auth }; } }),
    fetcher: async (path, options) => {
      if (path === "/api/auth/config") return { ok: true, json: async () => ({ available: true, supabase_url: "https://fixture.invalid", publishable_key: "public" }) };
      calls.push({ path, options });
      return { ok: true, json: async () => ({ workspaces: [] }) };
    },
  });
  await value.send("investor@example.test");
  await value.verify("investor@example.test", "123456");
  await value.request("/api/workspaces");
  assert.deepEqual(calls[0], { email: "investor@example.test", options: { emailRedirectTo: "http://fixture/" } });
  assert.equal(calls[1].type, "email");
  assert.equal(calls[2].options.headers.Authorization, "Bearer fixture-token");
  assert.equal(calls[2].options.cache, "no-store");
});

test("email callbacks use the current site root with a slash for Preview wildcard matching", async () => {
  for (const origin of ["https://living-investment-thesis-agent.vercel.app",
    "https://living-investment-thesis-agent-git-feature-tasconyeric-slack.vercel.app", "http://127.0.0.1:3000"]) {
    let sent;
    const value = await connectCloud(() => {}, { origin,
      fetcher: async () => ({ ok: true, json: async () => ({ available: true, supabase_url: "https://fixture.invalid", publishable_key: "public" }) }),
      loadSdk: async () => ({ createClient: () => ({ auth: {
        onAuthStateChange() {}, getSession: async () => ({ data: { session: null } }),
        signInWithOtp: async (body) => { sent = body; return {}; },
      } }) }),
    });
    await value.send("owner@example.test");
    assert.equal(sent.options.emailRedirectTo, origin + "/");
    assert.equal(new URL(sent.options.emailRedirectTo).origin, origin);
  }
});
