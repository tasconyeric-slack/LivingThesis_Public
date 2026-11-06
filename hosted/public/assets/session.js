// Session-only product state. API payloads remain unmodified inside records.
export const STORAGE = "living-thesis-hosted-v061";
export const LEGACY_STORAGE = "living-thesis-hosted-v06";
const copy = (value) => structuredClone(value);
const actions = ["accept", "edit", "reject", "keep_unresolved"];
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
export const sameStanding = (a, b) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function validStanding(s) {
  return (
    !!s &&
    typeof s.ticker === "string" &&
    typeof s.statement === "string" &&
    Number.isInteger(s.version) &&
    s.version > 0 &&
    Array.isArray(s.falsifiers) &&
    s.falsifiers.every((f) => typeof f === "string") &&
    Array.isArray(s.drivers) &&
    s.drivers.length >= 3 &&
    s.drivers.length <= 5 &&
    s.drivers.every(
      (d) =>
        typeof d.driver_id === "string" &&
        typeof d.title === "string" &&
        typeof d.statement === "string" &&
        typeof d.what_to_watch === "string" &&
        Array.isArray(d.falsifiers) &&
        d.falsifiers.every((f) => typeof f === "string"),
    )
  );
}
export function freshSession() {
  return {
    schemaVersion: 1,
    view: "dashboard",
    activeId: null,
    tab: "overview",
    workspaces: [],
    creation: { draft: {} },
  };
}
// The confirmed custom proposal must meet the hosted API's trimmed text bounds.
// Legacy and synthetic snapshots use validStanding without inventing falsifiers.
// The thesis-level list aggregates every driver's falsifiers (5 drivers x 5); keep in step with
// Standing in hosted/models.py. A model-proposed structure is still capped at 5 server-side.
export const MAX_DRIVER_FALSIFIERS = 5;
export const MAX_THESIS_FALSIFIERS = 25;
export function validReviewStanding(s) {
  const text = (value, min, max) =>
    typeof value === "string" &&
    Array.from(value.trim()).length >= min &&
    Array.from(value.trim()).length <= max;
  const falsifiers = (values, max) =>
    Array.isArray(values) &&
    values.length >= 1 &&
    values.length <= max &&
    values.every((value) => text(value, 3, 800));
  return (
    validStanding(s) &&
    text(s.statement, 10, 2000) &&
    falsifiers(s.falsifiers, MAX_THESIS_FALSIFIERS) &&
    s.drivers.every(
      (d) =>
        text(d.title, 3, 80) &&
        text(d.statement, 3, 800) &&
        text(d.what_to_watch, 3, 600) &&
        falsifiers(d.falsifiers, MAX_DRIVER_FALSIFIERS),
    )
  );
}
export const activeWorkspace = (state) =>
  state.workspaces.find((w) => w.id === state.activeId);
// A workspace is identified by its ticker, normalized like the hosted API does.
// The synthetic demo is a sandbox with its own single slot, so it never
// occupies (or collides with) a real company's ticker.
export const normalizeTicker = (value) => String(value ?? "").trim().toUpperCase();
export const workspaceKey = (item) =>
  item.mode === "demo" ? "demo" : normalizeTicker(item.standing?.ticker);
export const findByTicker = (workspaces, ticker) => {
  const key = normalizeTicker(ticker);
  return key
    ? workspaces.find(
        (item) =>
          item.mode !== "demo" && normalizeTicker(item.standing?.ticker) === key,
      )
    : undefined;
};
export const demoWorkspace = (workspaces) =>
  workspaces.find((item) => item.mode === "demo");
function workspace(state, id) {
  const w = state.workspaces.find((item) => item.id === id);
  if (!w) throw new Error("workspace_unavailable");
  return w;
}
export function createWorkspace(
  state,
  { id, standing, authored, language, mode = "custom", time },
) {
  if (!validStanding(standing) || state.workspaces.some((w) => w.id === id))
    throw new Error("invalid_input");
  const key = workspaceKey({ mode, standing });
  if (state.workspaces.some((w) => workspaceKey(w) === key))
    throw new Error("duplicate_ticker");
  const next = copy(state);
  next.workspaces.push({
    id,
    mode,
    standing: copy(standing),
    authored,
    language,
    createdAt: time,
    updatedAt: time,
    versions: [{ standing: copy(standing), time }],
    evidence: [],
    assessments: [],
    decisions: [],
    pendingId: null,
    action: null,
    draft: {},
    history: [{ type: "created", version: standing.version, time }],
  });
  next.activeId = id;
  next.view = "workspace";
  next.tab = "overview";
  next.creation = { draft: {} };
  return next;
}
export function registerEvidence(
  state,
  workspaceId,
  { id, evidence, time, event = null },
) {
  const next = copy(state),
    w = workspace(next, workspaceId);
  if (w.evidence.some((item) => item.id === id))
    throw new Error("invalid_input");
  w.evidence.push({
    id,
    content: copy(evidence),
    time,
    event,
    sourceVerified: false,
    synthetic: w.mode === "demo",
    status: "pending",
    assessmentId: null,
  });
  return next;
}
export function registerAssessment(
  state,
  workspaceId,
  { id, evidenceId, assessment, receipt = null, language, time, baseStanding },
) {
  const next = copy(state),
    w = workspace(next, workspaceId);
  const record = w.evidence.find((item) => item.id === evidenceId);
  if (
    !record ||
    !sameStanding(w.standing, baseStanding) ||
    w.assessments.some((a) => a.id === id)
  )
    throw new Error("stale_assessment");
  if (w.pendingId) {
    const old = w.assessments.find((a) => a.id === w.pendingId);
    old.status = "superseded";
    const oldEvidence = w.evidence.find((r) => r.id === old.evidenceId);
    if (oldEvidence) oldEvidence.status = "superseded";
  }
  w.assessments.push({
    id,
    evidenceId,
    payload: copy(assessment),
    receipt,
    language,
    time,
    baseStanding: copy(baseStanding),
    status: "pending",
  });
  record.status = "assessed";
  record.assessmentId = id;
  w.pendingId = id;
  w.action = "review";
  w.draft = {};
  w.updatedAt = time;
  w.history.push({
    type: "assessed",
    assessmentId: id,
    evidenceId,
    version: w.standing.version,
    time,
  });
  return next;
}
export function applyWorkspaceDecision(
  state,
  workspaceId,
  assessmentId,
  result,
  time,
) {
  const next = copy(state),
    w = workspace(next, workspaceId);
  const a = w.assessments.find((item) => item.id === assessmentId);
  if (
    !a ||
    w.pendingId !== a.id ||
    a.status !== "pending" ||
    !sameStanding(w.standing, a.baseStanding)
  )
    throw new Error("stale_assessment");
  if (!actions.includes(result.decision) || !validStanding(result.standing))
    throw new Error("invalid_input");
  const before = w.standing;
  const changed = before.statement !== result.standing.statement;
  const expected = {
    ...copy(before),
    statement: result.standing.statement,
    version: before.version + (changed ? 1 : 0),
  };
  if (
    result.changed !== changed ||
    !sameStanding(expected, result.standing) ||
    (changed && !["accept", "edit"].includes(result.decision))
  )
    throw new Error("invalid_input");
  w.standing = copy(result.standing);
  a.status = result.decision === "keep_unresolved" ? "unresolved" : "decided";
  w.decisions.push({
    assessmentId,
    action: result.decision,
    changed,
    fromVersion: before.version,
    version: w.standing.version,
    statement: w.standing.statement,
    time,
  });
  const evidence = w.evidence.find((item) => item.id === a.evidenceId);
  if (evidence)
    evidence.status =
      result.decision === "keep_unresolved" ? "unresolved" : "decided";
  w.history.push({
    type: "decision",
    assessmentId,
    action: result.decision,
    changed,
    fromVersion: before.version,
    version: w.standing.version,
    time,
  });
  if (changed) w.versions.push({ standing: copy(w.standing), time });
  w.pendingId = null;
  w.action = null;
  w.draft = {};
  w.updatedAt = time;
  next.tab = "overview";
  return next;
}
export function restoreSession(raw, legacy) {
  try {
    if (raw) {
      const state = typeof raw === "string" ? JSON.parse(raw) : raw;
      const record = (value) =>
        value && typeof value === "object" && !Array.isArray(value);
      const strings = (value) =>
        Array.isArray(value) && value.every((item) => typeof item === "string");
      const stamp = (value) =>
        value == null ||
        (typeof value === "string" && Number.isFinite(Date.parse(value)));
      const validAssessment = (a) =>
        record(a) &&
        typeof a.id === "string" &&
        validStanding(a.baseStanding) &&
        (a.receipt == null || typeof a.receipt === "string") &&
        record(a.payload) &&
        ["support", "weaken", "contradict", "unresolved"].includes(
          a.payload.relation,
        ) &&
        typeof a.payload.reasoning === "string" &&
        Array.isArray(a.payload.driver_impacts) &&
        a.payload.driver_impacts.every(
          (i) =>
            record(i) &&
            typeof i.driver_id === "string" &&
            typeof i.reasoning === "string" &&
            typeof i.exact_quote === "string" &&
            ["support", "weaken", "contradict", "unresolved"].includes(
              i.relation,
            ),
        ) &&
        strings(a.payload.what_changed) &&
        strings(a.payload.what_to_watch) &&
        record(a.payload.proposed_change) &&
        ["revise", "no_change", "hold_unresolved"].includes(
          a.payload.proposed_change.action,
        ) &&
        typeof a.payload.proposed_change.reason === "string" &&
        (a.payload.proposed_change.action !== "revise" ||
          typeof a.payload.proposed_change.revised_statement === "string") &&
        stamp(a.time);
      const ids = new Set();
      if (
        !record(state) ||
        state.schemaVersion !== 1 ||
        !["dashboard", "baseline", "replay", "create", "workspace"].includes(state.view) ||
        !["overview", "evidence", "history"].includes(state.tab) ||
        !record(state.creation) ||
        !record(state.creation.draft) ||
        (state.creation.proposal && !validStanding(state.creation.proposal)) ||
        !Array.isArray(state.workspaces) ||
        !state.workspaces.every((item) => {
          if (
            !record(item) ||
            typeof item.id !== "string" ||
            ids.has(item.id) ||
            !["custom", "demo"].includes(item.mode) ||
            !validStanding(item.standing) ||
            !record(item.draft) ||
            !stamp(item.createdAt) ||
            !stamp(item.updatedAt)
          )
            return false;
          ids.add(item.id);
          return (
            [
              item.evidence,
              item.assessments,
              item.decisions,
              item.versions,
              item.history,
            ].every(Array.isArray) &&
            item.versions.length > 0 &&
            sameStanding(item.versions.at(-1)?.standing, item.standing) &&
            item.versions.every((v, index) => {
              if (!record(v) || !validStanding(v.standing) || !stamp(v.time))
                return false;
              if (!index) return true;
              const previous = item.versions[index - 1].standing;
              return (
                v.standing.statement !== previous.statement &&
                sameStanding(v.standing, {
                  ...previous,
                  statement: v.standing.statement,
                  version: previous.version + 1,
                })
              );
            }) &&
            item.evidence.every(
              (r) =>
                record(r) &&
                typeof r.id === "string" &&
                record(r.content) &&
                ["event_date", "information", "source", "source_text"].every(
                  (k) => typeof r.content[k] === "string",
                ) &&
                stamp(r.time),
            ) &&
            item.assessments.every(validAssessment) &&
            item.decisions.every(
              (d) =>
                record(d) &&
                actions.includes(d.action) &&
                Number.isInteger(d.version) &&
                stamp(d.time),
            ) &&
            item.history.every(
              (h) =>
                record(h) &&
                ["created", "assessed", "decision", "legacy"].includes(
                  h.type,
                ) &&
                stamp(h.time) &&
                (h.type !== "decision" || actions.includes(h.action)) &&
                (h.type !== "legacy" ||
                  (Array.isArray(h.records) && h.records.every(record))),
            ) &&
            (!item.pendingId ||
              item.assessments.some((a) => a.id === item.pendingId))
          );
        }) ||
        (state.view === "workspace" && !ids.has(state.activeId))
      )
        return freshSession();
      const restored = copy(state);
      // Earlier releases let every click create another demo. The demo is a
      // sandbox, so keep only the most recently updated one.
      const demos = restored.workspaces.filter((item) => item.mode === "demo");
      if (demos.length > 1) {
        const stamped = (item) => (item.updatedAt ? Date.parse(item.updatedAt) : 0);
        const newest = demos.reduce((a, b) => (stamped(b) >= stamped(a) ? b : a));
        restored.workspaces = restored.workspaces.filter(
          (item) => item.mode !== "demo" || item === newest,
        );
        if (demos.some((item) => item.id === restored.activeId))
          restored.activeId = newest.id;
      }
      for (const item of restored.workspaces)
        for (const evidence of item.evidence)
          if (evidence.status === "pending" && !evidence.assessmentId) {
            evidence.status = "failed";
            item.error = "interrupted_request";
          }
      return restored;
    }
    if (!legacy) return freshSession();
    const old = typeof legacy === "string" ? JSON.parse(legacy) : legacy;
    if (!["custom", "demo"].includes(old.mode)) return freshSession();
    if (["define", "drivers"].includes(old.stage)) {
      const next = freshSession();
      next.view = "create";
      next.creation = {
        draft: old.draft || {},
        ...(old.stage === "drivers" && validStanding(old.standing)
          ? { proposal: copy(old.standing) }
          : {}),
      };
      return next;
    }
    if (!validStanding(old.standing)) return freshSession();
    let next = createWorkspace(freshSession(), {
      id: "legacy-workspace",
      standing: old.standing,
      authored: old.draft?.statement ?? old.standing.statement,
      language: "en",
      mode: old.mode,
      time: null,
    });
    const w = activeWorkspace(next);
    const lastDecision =
      old.lastResult?.decision || old.history?.at(-1)?.decision;
    const legacyStatus =
      old.stage === "done"
        ? lastDecision === "keep_unresolved"
          ? "unresolved"
          : "decided"
        : "pending";
    w.decisions = (old.history || [])
      .filter(
        (h) => actions.includes(h.decision) && Number.isInteger(h.version),
      )
      .map((h) => ({
        action: h.decision,
        version: h.version,
        changed: !!h.changed,
        fromVersion: h.changed ? h.version - 1 : h.version,
        time: null,
        assessmentId: null,
      }));
    w.history = [
      { type: "legacy", time: null, records: copy(old.history || []) },
    ];
    if (
      old.assessment &&
      old.evidence &&
      validStanding(old.baseStanding || old.standing)
    ) {
      w.evidence.push({
        id: "legacy-evidence",
        content: copy(old.evidence),
        time: null,
        event: old.event || null,
        sourceVerified: false,
        synthetic: old.mode === "demo",
        status: old.stage === "done" ? legacyStatus : "assessed",
        assessmentId: "legacy-assessment",
      });
      w.assessments.push({
        id: "legacy-assessment",
        evidenceId: "legacy-evidence",
        payload: copy(old.assessment),
        receipt: old.receipt || null,
        language: "en",
        time: null,
        baseStanding: copy(old.baseStanding || old.standing),
        status: legacyStatus,
      });
      if (old.stage !== "done") {
        w.pendingId = "legacy-assessment";
        w.action = "review";
      }
      if (old.baseStanding && !sameStanding(old.baseStanding, old.standing))
        w.versions.unshift({ standing: copy(old.baseStanding), time: null });
    }
    w.draft = {
      evidence: old.evidenceDraft || {},
      decision: old.decision || null,
      editedStatement: old.editedStatement || "",
    };
    // Use the same structural and evolution checks for migrated artifacts.
    return restoreSession(next);
  } catch {
    return freshSession();
  }
}
