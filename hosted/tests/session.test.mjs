import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  freshSession,
  createWorkspace,
  registerEvidence,
  registerAssessment,
  applyWorkspaceDecision,
  restoreSession,
  sameStanding,
  validReviewStanding,
  normalizeTicker,
  findByTicker,
  demoWorkspace,
} from "../public/assets/session.js";
import { demoAssessment, applyDemoDecision } from "../public/assets/product.js";
const data = JSON.parse(
  readFileSync(new URL("../public/assets/demo.json", import.meta.url)),
);
test("confirmed review enforces meaningful trimmed hosted text boundaries", () => {
  const proposal = structuredClone(data.standing);
  proposal.falsifiers = ["Test falsifier"];
  for (const d of proposal.drivers) d.falsifiers = ["Test falsifier"];
  assert.equal(validReviewStanding(proposal), true);
  for (const [field, minimum, maximum] of [
    ["statement", 10, 2000],
    ["title", 3, 80],
    ["driver", 3, 800],
    ["watch", 3, 600],
  ]) {
    const set = (value) => {
      const s = structuredClone(proposal);
      if (field === "statement") s.statement = value;
      else
        s.drivers[0][
          { title: "title", driver: "statement", watch: "what_to_watch" }[field]
        ] = value;
      return s;
    };
    assert.equal(validReviewStanding(set(" ".repeat(minimum))), false);
    assert.equal(validReviewStanding(set(" a ")), false);
    assert.equal(validReviewStanding(set("x".repeat(minimum))), true);
    assert.equal(validReviewStanding(set("😀".repeat(minimum - 1))), false);
    assert.equal(validReviewStanding(set("😀".repeat(minimum))), true);
    assert.equal(validReviewStanding(set("x".repeat(maximum))), true);
    assert.equal(validReviewStanding(set("x".repeat(maximum + 1))), false);
  }
});
function seed() {
  return createWorkspace(freshSession(), {
    id: "one",
    standing: data.standing,
    authored: "My original thesis",
    language: "en",
    time: "2026-10-05",
  });
}
function assessed(state = seed()) {
  state = registerEvidence(state, "one", {
    id: "e1",
    evidence: data.events.rubin,
    time: "2026-10-05",
  });
  return registerAssessment(state, "one", {
    id: "a1",
    evidenceId: "e1",
    assessment: demoAssessment(data, "rubin"),
    receipt: "original-receipt",
    language: "zh",
    time: "2026-10-05",
    baseStanding: state.workspaces[0].standing,
  });
}
test("confirmed creation enters workspace and independently isolates a second thesis", () => {
  const first = seed();
  const second = createWorkspace(first, {
    id: "two",
    standing: { ...data.standing, ticker: "MSFT" },
    authored: "Another original thesis",
    language: "zh",
    time: "later",
  });
  assert.equal(second.view, "workspace");
  assert.equal(second.activeId, "two");
  assert.equal(second.workspaces.length, 2);
  assert.deepEqual(first.workspaces, [second.workspaces[0]]);
  assert.equal(second.workspaces[0].authored, "My original thesis");
  assert.throws(() =>
    createWorkspace(second, { id: "one", standing: data.standing }),
  );
});
test("a ticker identifies exactly one workspace, however it is written", () => {
  const first = seed(),
    ticker = first.workspaces[0].standing.ticker;
  assert.equal(normalizeTicker("  nvda "), "NVDA");
  for (const variant of [ticker.toLowerCase(), ` ${ticker} `])
    assert.throws(
      () =>
        createWorkspace(first, {
          id: "dup",
          standing: { ...data.standing, ticker: variant },
          authored: "A second thesis for the same company",
          language: "en",
          time: "later",
        }),
      { message: "duplicate_ticker" },
    );
  assert.equal(first.workspaces.length, 1);
  assert.equal(findByTicker(first.workspaces, ` ${ticker.toLowerCase()}`).id, "one");
  assert.equal(findByTicker(first.workspaces, ""), undefined);
  assert.equal(findByTicker(first.workspaces, "MSFT"), undefined);
});
test("the synthetic demo is a single sandbox that never occupies a real ticker", () => {
  const demo = (state, id) =>
    createWorkspace(state, {
      id,
      standing: data.standing,
      authored: data.standing.statement,
      language: "en",
      mode: "demo",
      time: "now",
    });
  const withDemo = demo(freshSession(), "demo-1");
  // The demo uses the real company's ticker yet does not block adopting it.
  const both = createWorkspace(withDemo, {
    id: "real",
    standing: data.standing,
    authored: "My own NVIDIA thesis",
    language: "en",
    time: "later",
  });
  assert.equal(both.workspaces.length, 2);
  assert.equal(findByTicker(both.workspaces, data.standing.ticker).id, "real");
  assert.equal(demoWorkspace(both.workspaces).id, "demo-1");
  // The reverse order works too, but a second demo never accumulates.
  assert.equal(demo(seed(), "demo-2").workspaces.length, 2);
  assert.throws(() => demo(withDemo, "demo-3"), { message: "duplicate_ticker" });
});
test("restoring collapses earlier duplicate demos but never touches real theses", () => {
  const base = createWorkspace(seed(), {
    id: "demo-old",
    standing: data.standing,
    authored: data.standing.statement,
    language: "en",
    mode: "demo",
    time: "2026-10-01T00:00:00.000Z",
  });
  const stored = structuredClone(base);
  const old = stored.workspaces[1];
  old.updatedAt = "2026-10-01T00:00:00.000Z";
  const newer = structuredClone(old);
  Object.assign(newer, { id: "demo-new", updatedAt: "2026-10-02T00:00:00.000Z" });
  const real = structuredClone(stored.workspaces[0]);
  real.id = "real-duplicate";
  stored.workspaces.push(newer, real);
  stored.activeId = "demo-old";
  stored.view = "workspace";
  const restored = restoreSession(JSON.stringify(stored));
  assert.deepEqual(
    restored.workspaces.map((item) => item.id),
    ["one", "demo-new", "real-duplicate"],
  );
  assert.equal(restored.activeId, "demo-new");
  assert.equal(restored.view, "workspace");
});
test("evidence and assessment preserve Standing and source-unverified semantics", () => {
  const before = seed(),
    next = assessed(before),
    w = next.workspaces[0];
  assert.deepEqual(w.standing, before.workspaces[0].standing);
  assert.equal(before.workspaces[0].evidence.length, 0);
  assert.equal(w.evidence[0].sourceVerified, false);
  assert.equal(
    w.evidence[0].content.source_text,
    data.events.rubin.source_text,
  );
  assert.equal(w.assessments[0].receipt, "original-receipt");
  assert.equal(w.assessments[0].language, "zh");
  assert.deepEqual(
    w.history.map((h) => h.type),
    ["created", "assessed"],
  );
});
for (const action of ["accept", "edit", "reject", "keep_unresolved"])
  test(`${action} records history and creates only warranted versions`, () => {
    const state = assessed(),
      w = state.workspaces[0];
    const result = applyDemoDecision(
      w.standing,
      w.assessments[0].payload,
      action,
      "My human authored revised investment thesis.",
    );
    const next = applyWorkspaceDecision(state, "one", "a1", result, "later"),
      updated = next.workspaces[0];
    assert.equal(
      updated.standing.version,
      ["accept", "edit"].includes(action) ? 2 : 1,
    );
    assert.equal(updated.versions.length, result.changed ? 2 : 1);
    assert.equal(updated.decisions[0].action, action);
    assert.equal(updated.history.at(-1).type, "decision");
    assert.equal(updated.pendingId, null);
    assert.equal(w.standing.version, 1);
    assert.throws(
      () => applyWorkspaceDecision(next, "one", "a1", result, "later"),
      /stale/,
    );
  });
test("unchanged accepted statement does not fabricate a new version", () => {
  const state = assessed(),
    w = state.workspaces[0];
  const next = applyWorkspaceDecision(
    state,
    "one",
    "a1",
    { standing: w.standing, changed: false, decision: "accept" },
    "later",
  );
  assert.equal(next.workspaces[0].versions.length, 1);
});
test("superseded and stale assessments cannot overwrite current Standing", () => {
  let state = assessed();
  state = registerEvidence(state, "one", {
    id: "e2",
    evidence: data.events.rubin,
    time: "later",
  });
  state = registerAssessment(state, "one", {
    id: "a2",
    evidenceId: "e2",
    assessment: demoAssessment(data, "rubin"),
    language: "en",
    baseStanding: state.workspaces[0].standing,
  });
  assert.equal(state.workspaces[0].assessments[0].status, "superseded");
  assert.throws(
    () => applyWorkspaceDecision(state, "one", "a1", {}, "later"),
    /stale/,
  );
  state.workspaces[0].standing.statement += " A later human change.";
  assert.throws(
    () => applyWorkspaceDecision(state, "one", "a2", {}, "later"),
    /stale/,
  );
});
test("reload restores full session and rejects malformed envelopes", () => {
  const state = assessed();
  assert.deepEqual(restoreSession(JSON.stringify(state)), state);
  for (const bad of ["{", "{}", JSON.stringify({ ...state, workspaces: [{}] })])
    assert.deepEqual(restoreSession(bad), freshSession());
  assert.equal(freshSession().workspaces.length, 0);
});
test("v06 pending receipts migrate verbatim without invented history", () => {
  const old = {
    mode: "custom",
    stage: "decision",
    standing: data.standing,
    baseStanding: data.standing,
    assessment: demoAssessment(data, "rubin"),
    receipt: "original.signed.receipt",
    evidence: data.events.rubin,
    history: [{ decision: "reject", version: 1 }],
    decision: "edit",
    editedStatement: "Saved draft",
  };
  const state = restoreSession(null, JSON.stringify(old)),
    w = state.workspaces[0];
  assert.deepEqual(w.standing, old.standing);
  assert.deepEqual(w.assessments[0].payload, old.assessment);
  assert.equal(w.assessments[0].receipt, old.receipt);
  assert.equal(w.history[0].time, null);
  assert.equal(w.draft.editedStatement, "Saved draft");
  assert.equal(w.versions.length, 1);
});
test("unconfirmed v06 driver review remains a proposal", () => {
  const state = restoreSession(null, {
    mode: "custom",
    stage: "drivers",
    standing: data.standing,
    draft: { statement: "Original" },
  });
  assert.equal(state.view, "create");
  assert.equal(state.workspaces.length, 0);
  assert.deepEqual(state.creation.proposal, data.standing);
});

test("equivalent Standing key ordering is harmless but changed content is stale", () => {
  const original = data.standing,
    reordered = Object.fromEntries(Object.entries(original).reverse());
  assert.equal(sameStanding(original, reordered), true);
  assert.equal(
    sameStanding(original, { ...reordered, statement: "Changed statement" }),
    false,
  );
});
test("reload interrupts unfinished assessment while retaining evidence and draft", () => {
  let state = registerEvidence(seed(), "one", {
    id: "interrupted",
    evidence: data.events.rubin,
    time: "2026-10-05",
  });
  state.workspaces[0].draft.evidence = data.events.rubin;
  const restored = restoreSession(JSON.stringify(state));
  assert.equal(restored.workspaces[0].evidence[0].status, "failed");
  assert.equal(restored.workspaces[0].error, "interrupted_request");
  assert.deepEqual(restored.workspaces[0].draft.evidence, data.events.rubin);
});
test("legacy unresolved decisions and known history remain open", () => {
  const old = {
    mode: "custom",
    stage: "done",
    standing: data.standing,
    evidence: data.events.rubin,
    assessment: demoAssessment(data, "rubin"),
    history: [{ decision: "keep_unresolved", version: 1, changed: false }],
    lastResult: { decision: "keep_unresolved" },
  };
  const restored = restoreSession(null, old),
    workspace = restored.workspaces[0];
  assert.equal(workspace.evidence[0].status, "unresolved");
  assert.equal(workspace.assessments[0].status, "unresolved");
  assert.equal(workspace.decisions[0].action, "keep_unresolved");
  assert.equal(workspace.decisions[0].time, null);
  assert.deepEqual(restoreSession(JSON.stringify(restored)), restored);
});
test("malformed restored nested artifacts fail safely before rendering", () => {
  for (const tamper of [
    (s) => delete s.workspaces[0].draft,
    (s) => (s.workspaces[0].assessments[0].payload.relation = "invented"),
    (s) => (s.workspaces[0].updatedAt = "bad-date"),
    (s) => (s.workspaces[0].assessments[0].receipt = 42),
    (s) => (s.creation.proposal = {}),
  ]) {
    const state = assessed();
    tamper(state);
    assert.deepEqual(restoreSession(JSON.stringify(state)), freshSession());
  }
});

test("restoration rejects current/snapshot divergence and incoherent versions", () => {
  for (const corrupt of [
    (s) => {
      s.workspaces[0].versions = [];
    },
    (s) => {
      s.workspaces[0].standing.statement = "Unrecorded arbitrary change";
    },
    (s) => {
      s.workspaces[0].versions[0].standing.version = 2;
    },
    (s) => {
      const w = s.workspaces[0];
      w.standing.version = 3;
      w.standing.statement = "Changed text with a version gap";
      w.versions.push({ standing: structuredClone(w.standing), time: null });
    },
    (s) => {
      const w = s.workspaces[0];
      w.standing.version = 2;
      w.versions.push({ standing: structuredClone(w.standing), time: null });
    },
    (s) => {
      const w = s.workspaces[0];
      w.standing.version = 2;
      w.standing.statement = "Changed but other assumptions were mutated";
      w.standing.drivers[0].title = "Mutated driver";
      w.versions.push({ standing: structuredClone(w.standing), time: null });
    },
  ]) {
    const state = seed();
    corrupt(state);
    assert.deepEqual(restoreSession(JSON.stringify(state)), freshSession());
  }
});

test("legacy malformed assessment/evidence/history resets safely before rendering", () => {
  const legacy = {
    mode: "custom",
    stage: "decision",
    standing: data.standing,
    baseStanding: data.standing,
    evidence: data.events.rubin,
    assessment: demoAssessment(data, "rubin"),
    receipt: "original-receipt",
    history: [],
  };
  for (const corrupt of [
    (s) => delete s.assessment.what_changed,
    (s) => (s.assessment.reasoning = null),
    (s) => (s.evidence.source_text = null),
    (s) => (s.history = [null]),
  ]) {
    const old = structuredClone(legacy);
    corrupt(old);
    assert.deepEqual(restoreSession(null, old), freshSession());
  }
  const valid = restoreSession(null, legacy);
  assert.equal(valid.workspaces[0].assessments[0].receipt, "original-receipt");
  assert.deepEqual(
    valid.workspaces[0].assessments[0].payload,
    legacy.assessment,
  );
});
