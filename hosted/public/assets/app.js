import { standingFromBaseline, mapForStanding } from "./baseline.js";
import { productIntro, baselineTile, baselineView, monitorabilityView } from "./baseline-view.js";
import { loadReplay, replayView } from "./replay-view.js";
import { checkCard, checkHistory, acquisitionNote, checkAssessmentExtras } from "./check-view.js";
import { demoAssessment, applyDemoDecision, localizeDemo } from "./product.js";
import {
  STORAGE,
  LEGACY_STORAGE,
  freshSession,
  restoreSession,
  activeWorkspace,
  createWorkspace,
  registerEvidence,
  registerAssessment,
  applyWorkspaceDecision,
  sameStanding,
  validReviewStanding,
  findByTicker,
  demoWorkspace,
} from "./session.js";
import { chooseLanguage, translate, LANGUAGE_STORAGE } from "./i18n.js";
import { connectCloud, newestWorkspace, importCandidates, importConflict, MutationKeys } from "./cloud.js";
const main = document.querySelector("#main");
let buildRevision = "";
let language = chooseLanguage(null, navigator.language);
try {
  language = chooseLanguage(
    localStorage.getItem(LANGUAGE_STORAGE),
    navigator.language,
  );
} catch {}
let anonymousState;
const cloud = {
  available: false, connection: null, user: null, loading: false,
  saving: false, failed: false, error: "", authOpen: false,
  email: "", otp: "", sent: false, authBusy: false, imported: {},
  known: new Map(),
};
const mutationKeys = new MutationKeys();
// Transient Check for Updates UI state; the check itself lives on the server.
const checkErrors = {}, runDetails = {};
const CHECK_CODES = ["check_not_eligible", "monitoring_revalidation_required", "monitoring_mapping_invalid", "monitoring_rules_changed",
  "check_unavailable", "check_assessment_pending", "monitoring_already_confirmed", "sec_unavailable", "sec_malformed",
  "duplicate_ticker", "model_unavailable"];
const cloudStorage = () => `living-thesis-cloud-ui:${cloud.user.id}`;
const durable = (item = w()) => !!(cloud.user && item?.cloudRevision);
const blocked = (item = w()) => !!(cloud.loading || item?.cloudConflict);
const t = (key, params) => translate(language, key, params);
const e = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const localDate = () => {
  const value = new Date();
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
};
const tr = (key, params) => e(t(key, params)),
  now = () => new Date().toISOString(),
  id = () => crypto.randomUUID();
let state = freshSession(),
  busy = null,
  epoch = 0,
  navigationEpoch = 0,
  error = "",
  storageError = false,
  modelAvailable;
try {
  state = restoreSession(
    sessionStorage.getItem(STORAGE),
    sessionStorage.getItem(LEGACY_STORAGE),
  );
} catch {}
if (location.hash === "#nvidia-baseline") state.view = "baseline";
if (location.hash === "#nvidia-replay") state.view = "replay";
// The recorded replay is static data: fetched once, never recomputed in the browser.
let replay = { data: null, failed: false, loading: false };
const w = () => activeWorkspace(state);
anonymousState = structuredClone(state);
const decisionKey = {
  accept: "Accept",
  edit: "Edit",
  reject: "Reject",
  keep_unresolved: "Keep unresolved",
};
const relationKey = {
  support: "Support",
  weaken: "Weaken",
  contradict: "Contradict",
  unresolved: "Unresolved",
};
const statusKey = {
  pending: "Awaiting assessment",
  assessed: "Awaiting human decision",
  decided: "Decision recorded",
  unresolved: "Open question",
  failed: "Assessment failed",
  superseded: "Superseded by a newer assessment",
};
const failures = {
  auth_failed: "Sign in failed. Check your email or code and try again.",
  auth_required: "Your sign-in expired. Sign in again to recover your workspaces.",
  auth_unavailable: "Sign in is unavailable. Your browser session still works.",
  cloud_unavailable: "Could not save to your account. Your draft is retained; try again.",
  invalid_workspace: "This local workspace is not supported for import. Your local copy is unchanged.",
  invalid_cloud_state: "Your account workspace could not be loaded. Try again.",
  workspace_conflict: "This workspace changed elsewhere. Reload the latest version before continuing.",
  interrupted_request:
    "The assessment was interrupted by a reload. Analyze the evidence again.",
  invalid_input: "Check the form fields and try again.",
  duplicate_ticker: "You already have a workspace for this ticker. Open it instead.",
  model_unavailable:
    "Custom research is unavailable. The NVIDIA demo still works.",
  model_timeout: "Research took too long. Your inputs are saved; try again.",
  provider_unavailable: "The research service is unavailable. Try again later.",
  invalid_model_output: "The model result could not be validated. Try again.",
  empty_model_output: "The model returned an empty result. Try again.",
  ungrounded_result:
    "The result did not match the original source or thesis drivers. Try again.",
  stale_assessment:
    "This result is stale or expired. Analyze the evidence again before deciding.",
  no_revision:
    "There is no supported revision. Reject it or keep the question unresolved.",
  input_too_large: "Paste a shorter source excerpt.",
  network: "Could not reach the research service. Check your connection.",
  demo_unavailable: "The demo could not be loaded. Try again.",
  service_error: "Something went wrong. Your Standing Thesis is unchanged.",
  check_not_eligible: "Check for Updates is available only for a workspace adopted from the Owner-approved NVIDIA baseline.",
  monitoring_revalidation_required: "Your thesis changed. Confirm that the approved monitoring rules still apply before checking.",
  monitoring_mapping_invalid: "This thesis no longer matches the approved drivers and Watch Items, so automated checks are unavailable.",
  monitoring_rules_changed: "The approved monitoring rules on this server differ from the ones this workspace adopted, so automated checks are paused. Your thesis and history are unchanged.",
  check_unavailable: "Check for Updates is not available on this deployment yet. Nothing was changed.",
  check_assessment_pending: "Decide the pending SEC filing assessment before analyzing other evidence.",
  monitoring_already_confirmed: "The monitoring rules are already confirmed for this version.",
  sec_unavailable: "SEC EDGAR could not be reached. Nothing was changed; try again.",
  sec_malformed: "SEC EDGAR returned an unexpected response. Nothing was changed; try again.",
};
const alert = (code) =>
  code
    ? `<div class="alert" role="alert">${tr(failures[code] || failures.service_error)}<span>${tr("Your Standing Thesis is unchanged.")}</span></div>`
    : "";
const pill = (key, kind = "", params) =>
  `<span class="pill ${kind}">${tr(key, params)}</span>`;
const button = (key, action, kind = "primary", disabled = false, extra = "", params) =>
  `<button type="button" class="${kind}" data-action="${action}" ${disabled ? "disabled" : ""} ${extra}>${tr(key, params)}</button>`;
const list = (items) =>
  `<ul class="plain-list">${items.map((item) => `<li>${e(item)}</li>`).join("")}</ul>`;
const time = (value) =>
  value
    ? e(
        new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(value)),
      )
    : tr("Time unavailable in earlier session");
function save() {
  try {
    if (cloud.user) {
      // Never persist a browser copy as the account's canonical workspace.
      sessionStorage.setItem(cloudStorage(), JSON.stringify({
        view: state.view, activeId: state.activeId, tab: state.tab,
        creation: state.creation, imported: cloud.imported,
        mutations: mutationKeys.snapshot(),
        drafts: Object.fromEntries(state.workspaces.filter(durable).map((item) => [item.id, {
          draft: item.draft, action: item.action, staleAssessmentId: item.staleAssessmentId,
        }])),
        demos: state.workspaces.filter((item) => item.mode === "demo"),
      }));
    } else {
      sessionStorage.setItem(STORAGE, JSON.stringify(state));
      sessionStorage.removeItem(LEGACY_STORAGE);
      anonymousState = structuredClone(state);
    }
    storageError = false;
  } catch {
    storageError = true;
  }
}
function cloudError(err, targetId) {
  const target = state.workspaces.find((item) => item.id === targetId);
  const assessmentError = ["stale_assessment", "no_revision", ...CHECK_CODES].includes(err.message);
  const code = err.status === 409 && !assessmentError ? "workspace_conflict" :
    failures[err.message] ? err.message : "cloud_unavailable";
  if (target) {
    target.error = code;
    if (err.status === 409 && !assessmentError) target.cloudConflict = true;
    if (err.message === "stale_assessment") target.staleAssessmentId = target.pendingId;
  } else cloud.error = code;
  cloud.failed = true;
}
function putCloud(wrapper, options = {}) {
  const index = state.workspaces.findIndex((item) => item.id === wrapper.id);
  const previous = index < 0 ? cloud.known.get(wrapper.id) || {} : state.workspaces[index];
  const item = newestWorkspace(wrapper, previous);
  if (item === previous) return previous;
  cloud.known.set(wrapper.id, item);
  if (options.clearDraft) item.draft = {};
  if (options.action !== undefined) item.action = options.action;
  if (wrapper.archived_at) {
    state.workspaces = state.workspaces.filter((item) => item.id !== wrapper.id);
    if (state.activeId === wrapper.id) { state.view = "dashboard"; state.activeId = null; }
  } else if (index < 0) state.workspaces.push(item);
  else state.workspaces[index] = item;
  return item;
}
async function mutateCloud(scope, path, payload, targetId) {
  const requestEpoch = epoch, userId = cloud.user?.id;
  cloud.saving = true;
  cloud.failed = false;
  cloud.error = "";
  const idempotency_key = mutationKeys.key(scope, payload);
  save();
  render();
  try {
    const value = await cloud.connection.request(path, {
      ...payload, idempotency_key,
    });
    if (epoch !== requestEpoch || cloud.user?.id !== userId) return null;
    mutationKeys.complete(scope);
    return value;
  } catch (err) {
    if (epoch === requestEpoch && cloud.user?.id === userId) cloudError(err, targetId);
    throw err;
  } finally {
    if (epoch === requestEpoch && cloud.user?.id === userId) cloud.saving = false;
  }
}
async function loadCloudWorkspaces(recovery = {}) {
  const requestEpoch = epoch, userId = cloud.user.id;
  cloud.loading = true;
  cloud.error = "";
  render();
  try {
    const value = await cloud.connection.request("/api/workspaces");
    if (epoch !== requestEpoch || cloud.user?.id !== userId) return;
    const demos = state.workspaces.filter((item) => item.mode === "demo");
    const items = value.workspaces.map((wrapper) => {
      const previous = state.workspaces.find((item) => item.id === wrapper.id) || cloud.known.get(wrapper.id) || recovery.drafts?.[wrapper.id] || {};
      const item = newestWorkspace(wrapper, previous);
      cloud.known.set(wrapper.id, item);
      return item;
    }).filter((item) => !item.cloudArchived);
    state.workspaces = [...items, ...demos];
    if (state.view === "workspace" && !w()) { state.view = "dashboard"; state.activeId = null; }
    cloud.failed = false;
  } catch (err) {
    if (epoch === requestEpoch) cloudError(err);
  } finally {
    if (epoch === requestEpoch) { cloud.loading = false; save(); render(); }
  }
}
async function authChanged(session) {
  const user = session?.user || null;
  if (user?.id === cloud.user?.id) return;
  captureDrafts();
  save();
  epoch++;
  busy = null;
  mutationKeys.clear();
  cloud.user = user;
  cloud.loading = false;
  cloud.saving = false;
  cloud.failed = false;
  cloud.error = "";
  cloud.authOpen = false;
  cloud.sent = false;
  cloud.otp = "";
  cloud.imported = {};
  cloud.known.clear();
  if (!user) {
    state = structuredClone(anonymousState);
    save();
    render(true);
    return;
  }
  state = freshSession();
  let recovery = {};
  try { recovery = JSON.parse(sessionStorage.getItem(cloudStorage())) || {}; } catch {}
  cloud.imported = recovery.imported || {};
  mutationKeys.restore(recovery.mutations);
  if (["dashboard", "create", "workspace"].includes(recovery.view)) state.view = recovery.view;
  state.activeId = recovery.activeId || null;
  if (["overview", "evidence", "history"].includes(recovery.tab)) state.tab = recovery.tab;
  if (recovery.creation?.draft) state.creation = restoreSession({ ...freshSession(), creation: recovery.creation }).creation;
  // Demo state stays anonymous in nature, even while an investor is signed in.
  state.workspaces = restoreSession({ ...freshSession(), workspaces: recovery.demos || [] }).workspaces;
  await loadCloudWorkspaces(recovery);
}
function authPanel() {
  if (!cloud.authOpen || cloud.user) return "";
  return `<section class="account-panel work-card" aria-labelledby="signin-heading"><div class="card-top"><h2 id="signin-heading">${tr("Save your theses and return later")}</h2>${button("Close", "close-auth", "quiet")}</div><p>${tr("Sign in by email. Your anonymous session remains available.")}</p><form id="auth-form"><fieldset ${cloud.authBusy ? "disabled" : ""}><label for="auth-email">${tr("Email")}</label><input id="auth-email" name="email" type="email" maxlength="254" value="${e(cloud.email)}" required autocomplete="email">${cloud.sent ? `<p role="status">${tr("Check your email for a sign-in link or code. Open the link, or enter the code here.")}</p><label for="auth-code">${tr("Email code")}</label><input id="auth-code" name="token" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="12" value="${e(cloud.otp)}"><button class="primary">${tr("Verify code")}</button>${button("Send another email", "resend-auth", "secondary", cloud.authBusy)}` : `<button class="primary">${tr("Send sign-in email")}</button>`}</fieldset></form>${cloud.error ? `<div class="alert" role="alert">${tr(failures[cloud.error] || failures.auth_failed)}</div>` : ""}</section>`;
}
function cloudPanel() {
  if (!cloud.user) return authPanel();
  const candidates = importCandidates(anonymousState, cloud.imported);
  return `<section class="account-status" aria-label="${tr("Account workspace status")}"><span>${e(cloud.user.email || "")}</span><span role="status">${tr(cloud.loading ? "Loading your theses…" : cloud.saving ? "Saving to your account…" : cloud.failed ? "Account save needs attention" : "Saved to your account")}</span></section>${cloud.error ? `<div class="alert" role="alert">${tr(failures[cloud.error] || failures.cloud_unavailable)}${button("Reload my theses", "reload-cloud", "secondary", !!busy || cloud.loading)}</div>` : ""}${candidates.length ? `<section class="import-panel work-card"><h2>${tr("Import your browser session")}</h2><p>${tr("Review these local custom theses. Import preserves their evidence, assessments, decisions and versions. Your local copy stays until the server confirms.")}</p><ul class="plain-list">${candidates.map((item) => `<li><strong>${e(item.standing.ticker)}</strong> · ${tr("Standing v{version}", { version: item.standing.version })} · ${tr("{evidence} evidence records · {decisions} decisions · {versions} versions", { evidence: item.evidence.length, decisions: item.decisions.length, versions: item.versions.length })}${importConflict(item, state.workspaces) ? `<span class="field-note">${tr("A workspace for this ticker already exists in your account.")}</span>` : button("Import this thesis", "import-cloud", "secondary", !!busy || cloud.loading, `data-id="${e(item.id)}"`)}</li>`).join("")}</ul></section>` : ""}`;
}
function pending(item) {
  return item.assessments.find((a) => a.id === item.pendingId);
}
function captureDrafts() {
  for (const form of document.querySelectorAll("form")) {
    if (form.querySelector("fieldset:disabled")) continue;
    const values = Object.fromEntries(new FormData(form));
    if (form.id === "define-form") state.creation.draft = values;
    if (form.id === "drivers-form") state.creation.reviewDraft = values;
    if (form.id === "evidence-form" && w()) w().draft.evidence = values;
    if (form.id === "auth-form") { cloud.email = values.email || ""; cloud.otp = values.token || ""; }
  }
  const edited = document.querySelector("#edited-statement");
  if (edited && w()) w().draft.editedStatement = edited.value;
}
function navigate(view, tab = "overview", capture = true) {
  if (capture) captureDrafts();
  navigationEpoch++;
  state.view = view;
  window.history.replaceState(null, "", location.pathname + location.search + ({ baseline: "#nvidia-baseline", replay: "#nvidia-replay" }[view] || ""));
  state.tab = tab;
  error = "";
  save();
  render(true);
}
function shell() {
  document.documentElement.lang = language;
  document.title = t("Living Investment Thesis");
  document.querySelector(".skip-link").textContent = t("Skip to content");
  document.querySelector(".site-header").innerHTML =
    `<button class="brand" data-action="home" aria-label="${tr("My Theses")}"><span class="brand-mark">l<span>t</span></span><span>Living Thesis<span class="brand-sub">${tr("INVESTMENT RESEARCH, IN MOTION")}</span></span></button><nav aria-label="${tr("Main navigation")}">${button("Add Thesis", "create", "nav-create", !!busy || cloud.loading)}${cloud.available ? button(cloud.user ? "Sign out" : "Sign in", cloud.user ? "signout" : "signin", "quiet account-button", cloud.authBusy) : ""}<div class="language-control" role="group" aria-label="${tr("Interface language")}"><button type="button" data-action="language" data-language="zh" aria-pressed="${language === "zh"}">中文</button><button type="button" data-action="language" data-language="en" aria-pressed="${language === "en"}">EN</button></div></nav>`;
  document.querySelector("footer").innerHTML =
    `<span>Living Investment Thesis <span class="footer-version">v0.7.1 · Product Baseline${buildRevision ? ` · ${e(buildRevision.slice(0, 7))}` : ""}</span></span><span>${tr("Your thesis. Your judgment.")}</span>${button(cloud.user ? "Clear local drafts" : "Clear this session", "clear", "quiet")}`;
}
// A demo tile reads "NVIDIA demo" so it is never mistaken for the real NVDA workspace.
const tileLabel = (item) => (item.mode === "demo" ? tr("NVIDIA demo") : e(item.standing.ticker));
// The title is the card's single control; CSS stretches it over the whole card.
function thesisTile(item) {
  const latest = item.assessments.at(-1),
    last = item.decisions.at(-1);
  return `<article class="thesis-tile"><div class="card-top"><h2><button type="button" class="tile-link" data-action="open" data-id="${e(item.id)}">${tileLabel(item)}</button></h2>${pill("Standing v{version}", "green", { version: item.standing.version })}</div>${item.mode === "demo" ? pill("Synthetic · no live data", "amber") : ""}<p class="thesis-text">${e(item.standing.statement)}</p><h3>${tr("Key Drivers")}</h3><div class="preview-tags">${item.standing.drivers.map((d) => `<span>${e(d.title)}</span>`).join("")}</div><h3>${tr("Latest Change")}</h3><p>${latest ? e(latest.payload.what_changed[0]) : tr("No evidence assessed yet.")}</p><h3>${tr("What to Watch")}</h3><p>${e(item.standing.drivers[0].what_to_watch)}</p><p class="field-note">${tr("Last updated")}: ${time(item.updatedAt)}${last ? ` · ${tr(decisionKey[last.action])}` : ""}</p></article>`;
}
function dashboard() {
  // A ticker identifies one workspace. The investor's own NVDA workspace, or the
  // Owner baseline that stands in for it until adopted, is always the first card.
  const own = findByTicker(state.workspaces, "NVDA");
  const tiles = [
    own ? thesisTile(own) : baselineTile(language),
    ...state.workspaces.filter((item) => item !== own).map((item) => thesisTile(item)),
  ];
  return `${productIntro(language, { disabled: !!busy })}<div class="workspace-heading"><div><p class="eyebrow">LIVING THESIS</p><h2>${tr("My Theses")}</h2><p>${tr("Keep your investment view explicit. See what matters and what changed.")}</p></div></div><p class="session-note">${tr(cloud.user ? "Your account keeps your custom theses across browsers and devices." : "Saved in this browser tab session. Closing the session ends this workspace.")}</p>${alert(error)}<div class="thesis-grid">${tiles.join("")}</div>`;
}
// One workspace per ticker: instead of a dead end, offer the workspace that already exists.
function duplicateOpen(ticker) {
  const existing = error === "duplicate_ticker" && findByTicker(state.workspaces, ticker);
  return existing ? button("Open existing workspace", "open", "secondary", false, `data-id="${e(existing.id)}"`) : "";
}
function creation() {
  const c = state.creation,
    s = c.proposal,
    draft = c.draft || {},
    review = c.reviewDraft || {},
    value = (name, fallback) => e(review[name] ?? fallback);
  return `<div class="workspace-heading"><div><p class="eyebrow">${tr("ADD THESIS")}</p><h1>${tr(s ? "Does this capture your thinking?" : "What is your investment thesis?")}</h1><p>${tr(s ? "Review this AI structure proposal, then explicitly confirm Standing v1." : "One ticker and your own investment view. No outside research is added.")}</p></div>${button("← My Theses", "home", "quiet")}</div>${s ? `<section class="drivers-review"><details class="authored-original"><summary>${tr("Your original thesis")}</summary><p class="preserve-text">${e(draft.statement)}</p></details><form id="drivers-form"><fieldset ${busy ? "disabled" : ""}><label for="review-statement">${tr("Normalized thesis")} · ${e(s.ticker)}</label><textarea id="review-statement" name="statement" minlength="10" maxlength="2000" rows="3" required>${value("statement", s.statement)}</textarea><div class="driver-edit-grid">${s.drivers.map((d, i) => `<article class="edit-driver"><p class="eyebrow">${tr("Key Driver")} ${i + 1}</p><label for="d-title-${i}">${tr("Title")}</label><input id="d-title-${i}" name="title-${i}" minlength="3" maxlength="80" value="${value(`title-${i}`, d.title)}" required><label for="d-statement-${i}">${tr("Assumption")}</label><textarea id="d-statement-${i}" name="driver-${i}" minlength="3" maxlength="800" rows="2" required>${value(`driver-${i}`, d.statement)}</textarea><label for="d-watch-${i}">${tr("What to Watch")}</label><textarea id="d-watch-${i}" name="watch-${i}" minlength="3" maxlength="600" rows="2" required>${value(`watch-${i}`, d.what_to_watch)}</textarea><label for="d-falsifiers-${i}">${tr("Falsifiers · one per line")}</label><textarea id="d-falsifiers-${i}" name="falsifiers-${i}" rows="2" required>${value(`falsifiers-${i}`, d.falsifiers.join("\n"))}</textarea></article>`).join("")}</div><label for="thesis-falsifiers">${tr("Thesis falsifiers · one per line")}</label><textarea id="thesis-falsifiers" name="falsifiers" rows="2" required>${value("falsifiers", s.falsifiers.join("\n"))}</textarea>${alert(error)}${duplicateOpen(s.ticker)}<div class="form-actions">${button("← Back to my idea", "back-define", "secondary")}<button class="primary">${tr("Confirm Standing Thesis →")}</button></div></fieldset></form></section>` : `<section class="define-layout"><div>${modelAvailable === false ? `<div class="availability">${tr(failures.model_unavailable)}</div>` : ""}<form id="define-form"><fieldset ${busy ? "disabled" : ""}><label for="ticker">${tr("Ticker")}</label><input id="ticker" name="ticker" placeholder="NVDA, MSFT, 0700.HK" maxlength="12" pattern="[A-Za-z0-9.\\-]{1,12}" value="${e(draft.ticker)}" required autocomplete="off"><label for="statement">${tr("Your investment thesis")}</label><textarea id="statement" name="statement" rows="5" minlength="10" maxlength="2000" required placeholder="${tr("I believe this company will outperform because…")}">${e(draft.statement)}</textarea><p class="field-note">${tr("Write the idea in your own words. You review the AI structure before confirming it.")}</p>${alert(error)}${duplicateOpen(draft.ticker)}<button class="primary">${tr(busy ? "Structuring your thesis…" : "Find my Key Drivers →")}</button></fieldset>${busy ? `<p role="status" class="loading">${tr("Structuring your thesis…")}</p>` : ""}</form></div><aside class="onboarding-note"><p class="eyebrow">${tr("YOUR IDEA, MADE TESTABLE")}</p><h3>${tr("A good thesis knows what could break it.")}</h3><p>${tr("We suggest 3–5 Key Drivers, falsifiers and What to Watch based on your words.")}</p><p class="field-note">${tr(cloud.user ? "Your thesis and pasted evidence are sent to the research model. Confirmed workspaces are saved to your account." : "Your thesis and pasted evidence are sent to the research model for these requests. Session state stays in this tab.")}</p></aside></section>`}`;
}
function overview(item) {
  const s = item.standing,
    latest = item.assessments.at(-1),
    last = item.decisions.at(-1),
    impacts = latest?.payload.driver_impacts || [];
  return `<div class="overview-grid"><section><article class="standing-card"><div class="card-top"><h2>${tr("Standing Thesis")}</h2>${pill("Standing v{version}", "green", { version: s.version })}</div><p class="thesis-text preserve-text">${e(s.statement)}</p><p class="standing-note">${tr("Only your explicit decision can change this.")}</p></article><div class="drivers-head"><h2>${tr("Key Drivers")}</h2><span>${tr("{count} assumptions", { count: s.drivers.length })}</span></div><div class="workspace-drivers">${s.drivers
    .map((d, i) => {
      const impact = impacts.find((a) => a.driver_id === d.driver_id);
      return `<article class="driver-card"><div class="card-top"><h3><span class="driver-num">${i + 1}</span> ${e(d.title)}</h3>${pill(impact ? relationKey[impact.relation] : "No new evidence", impact ? "amber" : "")}</div><p>${e(d.statement)}</p>${impact ? `<p class="field-note">${tr("Latest evidence relation; not a verified investment rating.")}</p>` : ""}<h4>${tr("Falsifiers")}</h4>${d.falsifiers.length ? list(d.falsifiers) : `<p class="muted">${tr("No falsifier supplied in this synthetic scenario.")}</p>`}<h4>${tr("What to Watch")}</h4><p>${e(d.what_to_watch)}</p></article>`;
    })
    .join(
      "",
    )}</div></section><aside class="overview-aside"><article class="summary-card"><h2>${tr("Latest Change")}</h2>${latest ? list(latest.payload.what_changed) : `<p>${tr("No evidence assessed yet.")}</p>`}${latest?.status === "pending" ? button("Review pending assessment", "review", "secondary", !!busy) : ""}<h3>${tr("Last human decision")}</h3>${last ? `<p>${tr(decisionKey[last.action])} · ${last.changed ? `v${last.fromVersion} → v${last.version}` : tr("Standing v{version} retained", { version: last.version })}</p>` : `<p>${tr("No decision recorded yet.")}</p>`}</article><article class="summary-card"><h2>${tr("Falsifiers")}</h2>${list(s.falsifiers)}</article><article class="summary-card"><h2>${tr("What to Watch")}</h2>${list(latest?.payload.what_to_watch || s.drivers.map((d) => d.what_to_watch))}<p class="field-note">${tr(item.lineage ? "Check for Updates runs only when you click it. There is no background monitoring." : "Evidence is added manually. There is no background monitoring.")}</p></article><details class="authored-original"><summary>${tr("Your original thesis")}</summary><p class="preserve-text">${e(item.authored)}</p></details></aside></div>`;
}
function assessmentDetails(item, a) {
  const record = item.evidence.find((r) => r.id === a.evidenceId),
    p = a.payload;
  return `<div class="assessment-summary"><div class="card-top"><h2>${tr("What Changed")}</h2>${pill(relationKey[p.relation] || "Unresolved", "amber")}</div><p>${e(p.reasoning)}</p>${list(p.what_changed)}<h3>${tr("Affected Drivers")}</h3>${p.driver_impacts.length ? p.driver_impacts.map((impact) => `<article class="impact-item"><h4>${e(a.baseStanding.drivers.find((d) => d.driver_id === impact.driver_id)?.title || impact.driver_id)} · ${tr(relationKey[impact.relation])}</h4><p>${e(impact.reasoning)}</p><blockquote class="preserve-text">${e(impact.exact_quote)}</blockquote>${record?.acquisition ? "" : `<small>${e(record?.content.source)}${item.mode === "demo" ? "" : ` · ${tr("Source not independently verified")}`}</small>`}</article>`).join("") : `<p>${tr(item.mode === "demo" ? "No affected driver. Zero research work." : "No directional driver impact established.")}</p>`}${item.mode === "demo" ? `<div class="bounded-research"><h3>${tr("Bounded affected research")}</h3><p>${p.relevant ? tr("1 of 4 drivers · 2 of 6 research questions revisited. Other research retained.") : tr("0 drivers · 0 research questions · 0 provider or model calls.")}</p><details><summary>${tr("Technical Details")}</summary><p>${tr("Recorded walkthrough; exact quote matching does not check semantic entailment.")}</p></details></div>` : ""}${acquisitionNote(record, language)}${checkAssessmentExtras(a, language)}<h3>${tr("Suggested Revision")}</h3>${p.proposed_change.action === "revise" ? `<div class="revision-before"><span>${tr("Standing v{version}", { version: a.baseStanding.version })}</span><p>${e(a.baseStanding.statement)}</p></div><div class="revision-after"><span>${tr(a.status === "pending" ? "Proposal · not applied" : "Original proposal")}</span><p>${e(p.proposed_change.revised_statement)}</p></div>` : `<p>${tr("No thesis revision is proposed.")}</p>`}<p>${e(p.proposed_change.reason)}</p><h3>${tr("What to Watch next")}</h3>${list(p.what_to_watch)}</div>`;
}
function evidenceList(item) {
  return `<section class="evidence-history"><h2>${tr("Evidence")}</h2><p class="field-note">${tr("Manual sources are not independently verified. Exact quotes remain in the original source language.")}</p>${
    item.evidence.length
      ? item.evidence
          .slice()
          .reverse()
          .map((r) => {
            const a = item.assessments.find((a) => a.id === r.assessmentId);
            return `<article class="evidence-record"><div class="card-top"><h3>${e(r.content.information)}</h3>${pill(statusKey[r.status] || "Awaiting assessment")}</div><p class="field-note">${e(r.content.event_date)} · ${e(r.content.source)}</p>${r.acquisition ? acquisitionNote(r, language) : r.synthetic ? "" : pill("Source not independently verified", "amber")}<p>${a ? `${tr("Affected Drivers")}: ${e(a.payload.driver_impacts.map((impact) => a.baseStanding.drivers.find((d) => d.driver_id === impact.driver_id)?.title || impact.driver_id).join(" · ")) || tr("None")} · ${tr(relationKey[a.payload.relation])}` : tr("Not assessed yet.")}</p><details><summary>${tr("Original source text")}</summary><p class="preserve-text">${e(r.content.source_text)}</p></details>${a ? `<details><summary>${tr("View assessment")}</summary>${assessmentDetails(item, a)}</details>` : ""}${durable(item) && a?.importedOriginalStatus === "pending" ? `<p class="field-note">${tr("Imported assessments are historical. Analyze their evidence again before deciding.")}</p>${button("Analyze this evidence again", "reassess-record", "secondary", !!busy || blocked(item), `data-id="${e(r.id)}"`)}` : ""}</article>`;
          })
          .join("")
      : `<div class="empty-workspace"><p>${tr("No evidence in this session yet.")}</p>${button("Add Evidence / Analyze Update", "new-evidence", "primary", !!busy || blocked(item))}</div>`
  }</section>`;
}
function history(item) {
  return `<section><h2>${tr("History")}</h2><p class="field-note">${tr(durable(item) ? "Saved thesis evolution and human decisions." : "Thesis evolution and human decisions in this browser session.")}</p><ol class="timeline">${item.history
    .slice()
    .reverse()
    .map(
      (h) =>
        `<li><p class="field-note">${time(h.time)}</p>${h.type === "created" ? `<h3>${tr("Standing v{version} created", { version: h.version })}</h3>` : h.type === "assessed" ? `<h3>${tr("Evidence assessed")}</h3><p>${e(item.evidence.find((r) => r.id === h.evidenceId)?.content.information)}</p>` : h.type === "decision" ? `<h3>${tr("Human decision")}: ${tr(decisionKey[h.action])}</h3><p>${h.changed ? `v${h.fromVersion} → v${h.version}` : tr("Standing v{version} retained", { version: h.version })}</p>` : `<h3>${tr("Earlier session history")}</h3>${(h.records || []).map((r) => `<p>${tr(decisionKey[r.decision] || "Decision recorded")} · v${e(r.version)} · ${e(r.title)}</p>`).join("")}<p>${tr("Earlier source details and timestamps may be unavailable.")}</p>`}</li>`,
    )
    .join(
      "",
    )}</ol><details><summary>${tr("Thesis versions")}</summary>${item.versions.map((v) => `<article class="version-record"><h3>${tr("Standing v{version}", { version: v.standing.version })}</h3><p class="preserve-text">${e(v.standing.statement)}</p></article>`).join("")}</details></section>${durable(item) ? checkHistory(item, runDetails, { language, button }) : ""}`;
}
function evidenceAction(item) {
  const draft = item.draft.evidence || {};
  return `<section class="work-card action-panel" aria-labelledby="evidence-heading"><div class="card-top"><h2 id="evidence-heading">${tr("Add Evidence / Analyze Update")}</h2>${button("Close", "close-action", "quiet")}</div>${item.mode === "demo" ? `<div class="scenario-cards">${button("Office furniture update", "inject-irrelevant", "scenario", !!busy)}${button("Rubin timetable delayed", "inject-rubin", "scenario featured", !!busy)}</div>` : `<p>${tr("Paste dated evidence and its original source excerpt. Your summary is not a verified fact.")}</p><form id="evidence-form"><fieldset ${busy || blocked(item) ? "disabled" : ""}><label for="event-date">${tr("Evidence date")}</label><input id="event-date" name="event_date" type="date" value="${e(draft.event_date || localDate())}" required><label for="information">${tr("Your summary")}</label><textarea id="information" name="information" minlength="3" maxlength="3000" rows="2" required>${e(draft.information)}</textarea><label for="source">${tr("Source label")}</label><input id="source" name="source" minlength="3" maxlength="500" value="${e(draft.source)}" required><label for="source-text">${tr("Original source text")}</label><textarea id="source-text" name="source_text" minlength="10" maxlength="12000" rows="5" required>${e(draft.source_text)}</textarea><p class="field-note">${tr("Source not independently verified")}</p><button class="primary">${tr(busy ? "Analyzing evidence…" : "Analyze Update →")}</button></fieldset></form>`}${alert(item.error)}${busy?.workspaceId === item.id ? `<p role="status" class="loading">${tr("Analyzing evidence…")}</p>` : ""}</section>`;
}
function reviewAction(item) {
  const a = pending(item);
  if (!a) return "";
  const revision = a.payload.proposed_change.action === "revise",
    selected = item.draft.decision,
    stale =
      item.cloudConflict || item.error === "stale_assessment" ||
      !sameStanding(item.standing, a.baseStanding) ||
      (a.receipt && !a.check &&
        Date.now() / 1000 - Number(a.receipt.split(".")[0]) > 86400);
  return `<section class="work-card action-panel" aria-labelledby="assessment-heading"><div class="card-top"><h2 id="assessment-heading">${tr("Review evidence and decide")}</h2>${button("Close", "close-action", "quiet")}</div>${assessmentDetails(item, a)}${alert(item.error || (stale ? "stale_assessment" : ""))}${
    stale
      ? button("Analyze this evidence again", "reassess", "primary", !!busy)
      : `<fieldset class="decision-options" ${busy ? "disabled" : ""}><legend>${tr("How do you want to respond?")}</legend>${Object.entries(
          decisionKey,
        )
          .map(
            ([action, key]) =>
              `<label class="decision-option ${selected === action ? "selected" : ""}"><input type="radio" name="decision" value="${action}" ${selected === action ? "checked" : ""} ${!revision && ["accept", "edit"].includes(action) ? "disabled" : ""}><span><strong>${tr(key)}</strong><small>${tr({ accept: "Apply the suggested thesis text.", edit: "Write your own revision.", reject: "Retain your thesis and dismiss this suggestion.", keep_unresolved: "Retain your thesis; keep the evidence as an open question." }[action])}</small></span></label>`,
          )
          .join(
            "",
          )}</fieldset>${selected === "edit" ? `<label for="edited-statement">${tr("Your revised thesis")}</label><textarea id="edited-statement" minlength="10" maxlength="2000" rows="3" ${busy ? "disabled" : ""}>${e(item.draft.editedStatement ?? a.payload.proposed_change.revised_statement)}</textarea>` : ""}<div class="human-gate"><span>✓</span><p>${tr("Standing v{version} remains active until you explicitly apply a decision.", { version: item.standing.version })}</p></div>${button(busy?.route === "decision" ? "Applying…" : "Apply human decision →", "apply", "primary", !selected || !!busy || blocked(item))}`
  }</section>`;
}
function workspaceView() {
  const item = w();
  if (!item) return dashboard();
  return `<div class="workspace-heading"><div><p class="eyebrow">${tr("YOUR THESIS WORKSPACE")}</p><h1>${tileLabel(item)}</h1><p>${tr("Standing v{version}", { version: item.standing.version })} · ${tr(durable(item) ? "Saved to your account" : "Saved in this browser session")}</p></div><div class="workspace-actions">${button("← My Theses", "home", "quiet")}${button("Add Evidence / Analyze Update", "new-evidence", "primary", !!busy || blocked(item))}${item.mode === "demo" ? button("Restart demo", "restart-demo", "secondary", !!busy) : ""}${button("Save thesis as JSON ↓", "export", "secondary")}${durable(item) ? button("Archive thesis", "archive-cloud", "quiet", !!busy || blocked(item)) : ""}</div></div>${item.mode === "demo" ? `<p class="demo-disclosure">${tr("Synthetic NVIDIA demo: the thesis and both events are invented for this walkthrough. No real evidence is fetched and no model calls or credentials are used. This is separate from the real NVIDIA baseline.")}</p>` : ""}<div class="workspace-tabs" role="tablist" aria-label="${tr("Workspace sections")}">${["overview", "evidence", "history"].map((tab) => `<button role="tab" id="tab-${tab}" aria-controls="workspace-panel" aria-selected="${state.tab === tab}" tabindex="${state.tab === tab ? 0 : -1}" data-action="tab" data-tab="${tab}">${tr({ overview: "Overview", evidence: "Evidence", history: "History" }[tab])}</button>`).join("")}</div>${item.cloudConflict ? `<div class="alert" role="alert">${tr(failures.workspace_conflict)}${button("Reload latest workspace", "reload-workspace", "secondary", !!busy || cloud.loading)}</div>` : ""}${item.action === "evidence" ? evidenceAction(item) : item.action === "review" ? reviewAction(item) : ""}${state.tab === "overview" && durable(item) ? checkCard(item, { language, button, busy, error: checkErrors[item.id], alert }) : ""}<div id="workspace-panel" role="tabpanel" tabindex="0" aria-labelledby="tab-${state.tab}">${({ overview, evidence: evidenceList, history }[state.tab] || overview)(item)}${state.tab === "overview" && item.mode !== "demo" ? monitorabilityView(mapForStanding(item.standing), language) : ""}</div>`;
}
function replayPage() {
  const back = (key, action, kind) => button(key, action, kind, false);
  if (replay.data) return replayView(replay.data, language, back);
  if (!replay.loading && !replay.failed) {
    replay.loading = true;
    loadReplay().then((data) => { replay.data = data; }, () => { replay.failed = true; })
      .finally(() => { replay.loading = false; if (state.view === "replay") render(); });
  }
  return `<div class="workspace-heading"><div><p class="eyebrow">NVIDIA · HISTORICAL REPLAY</p></div>${back("← NVIDIA Standing Thesis", "baseline", "quiet")}</div>${replay.failed ? `<div class="alert" role="alert">${tr("The recorded replay could not be loaded. Try again.")}${back("Try again", "replay", "secondary")}</div>` : `<p role="status" class="loading">${tr("Loading the recorded replay…")}</p>`}`;
}
function render(focus = false) {
  // The baseline previews a workspace the investor does not hold yet. Once they
  // hold NVDA, a reload or a stale link shows their own workspace instead.
  if (state.view === "baseline") {
    const own = findByTicker(state.workspaces, "NVDA");
    if (own) {
      state.activeId = own.id;
      state.view = "workspace";
      state.tab = "overview";
      window.history.replaceState(null, "", location.pathname + location.search);
      save();
    }
  }
  const focused = document.activeElement;
  const selector = focused?.dataset.language
    ? `[data-language="${focused.dataset.language}"]`
    : focused?.id && focused.id !== "main"
      ? `#${CSS.escape(focused.id)}`
      : focused?.dataset.action
        ? `[data-action="${CSS.escape(focused.dataset.action)}"]`
        : null;
  shell();
  main.className = "workspace product-workspace";
  main.innerHTML =
    (storageError
      ? `<div class="alert" role="status">${tr("Session storage is unavailable or full. Export your workspace before reloading.")}</div>`
      : "") + cloudPanel() +
    (state.view === "create"
      ? creation()
      : state.view === "baseline"
        ? baselineView(language, (key, action, kind) => button(key, action, kind, !!busy || cloud.loading),
            { adoption: cloud.user ? "signed_in" : cloud.available ? "signed_out" : "unavailable" })
      : state.view === "replay"
        ? replayPage()
      : state.view === "workspace"
        ? workspaceView()
        : dashboard());
  if (focus) main.focus({ preventScroll: true });
  else if (selector)
    document.querySelector(selector)?.focus({ preventScroll: true });
}
async function api(route, body) {
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), 55000);
  try {
    const response = await fetch(`/api/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
      data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.code || "service_error");
    return data;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("model_timeout");
    if (err instanceof TypeError) throw new Error("network");
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
const demoLoads = new Map();
async function loadDemo(lang) {
  if (!demoLoads.has(lang))
    demoLoads.set(
      lang,
      (async () => {
        const read = async (path) => {
          const response = await fetch(path);
          if (!response.ok) throw new Error("demo_unavailable");
          return response.json();
        };
        const data = await read("/assets/demo.json");
        return lang === "zh"
          ? localizeDemo(data, await read("/assets/demo-zh.json"))
          : data;
      })(),
    );
  try {
    return await demoLoads.get(lang);
  } catch {
    demoLoads.delete(lang);
    throw new Error("demo_unavailable");
  }
}
// The demo is a single sandbox. Opening it again resumes it; only an explicit
// restart replaces it, so repeated clicks never accumulate NVDA workspaces.
async function startDemo(restart = false) {
  captureDrafts();
  const existing = demoWorkspace(state.workspaces);
  if (existing && !restart) {
    state.activeId = existing.id;
    return navigate("workspace", "overview", false);
  }
  const requestEpoch = epoch,
    requestNavigation = navigationEpoch,
    requestLanguage = language;
  busy = { route: "demo" };
  render();
  try {
    const data = await loadDemo(requestLanguage);
    if (epoch !== requestEpoch) return;
    const selection = {
        view: state.view,
        activeId: state.activeId,
        tab: state.tab,
      },
      creation = structuredClone(state.creation),
      replaced = demoWorkspace(state.workspaces);
    state = createWorkspace(
      { ...state, workspaces: state.workspaces.filter((item) => item.mode !== "demo") },
      {
        id: id(),
        standing: data.standing,
        authored: data.standing.statement,
        language: requestLanguage,
        mode: "demo",
        time: now(),
      },
    );
    state.creation = creation;
    // Never leave the saved selection pointing at the demo that was just replaced.
    if (navigationEpoch !== requestNavigation)
      Object.assign(state, {
        ...selection,
        activeId: selection.activeId === replaced?.id ? state.activeId : selection.activeId,
      });
  } finally {
    if (epoch === requestEpoch) {
      busy = null;
      save();
      render(navigationEpoch === requestNavigation);
    }
  }
}
async function inject(event) {
  const item = w(),
    targetId = item.id,
    requestEpoch = epoch,
    requestNavigation = navigationEpoch,
    base = structuredClone(item.standing);
  busy = { route: "demo", workspaceId: targetId };
  render();
  try {
    const data = await loadDemo(item.language);
    if (
      epoch !== requestEpoch ||
      !state.workspaces.some((item) => item.id === targetId)
    )
      return;
    const evidenceId = id(),
      stamp = now();
    state = registerEvidence(state, targetId, {
      id: evidenceId,
      evidence: data.events[event],
      time: stamp,
      event,
    });
    state = registerAssessment(state, targetId, {
      id: id(),
      evidenceId,
      assessment: demoAssessment(data, event),
      language: item.language,
      time: stamp,
      baseStanding: base,
    });
  } finally {
    if (epoch === requestEpoch) {
      busy = null;
      save();
      render(navigationEpoch === requestNavigation);
    }
  }
}
async function applyDecision() {
  captureDrafts();
  const item = w(),
    a = pending(item),
    action = item.draft.decision,
    base = structuredClone(item.standing),
    targetId = item.id,
    requestEpoch = epoch;
  if (!a || !action || blocked(item)) return;
  busy = { workspaceId: targetId, route: "decision" };
  item.error = "";
  save();
  render(true);
  try {
    if (durable(item)) {
      const result = await mutateCloud(`decision:${targetId}`, `/api/workspaces/${encodeURIComponent(targetId)}/decision`, {
        assessment_id: a.id, action,
        ...(action === "edit" ? { edited_statement: item.draft.editedStatement ?? a.payload.proposed_change.revised_statement } : {}),
        expected_revision: item.cloudRevision,
        expected_thesis_version: base.version,
      }, targetId);
      if (!result) return;
      putCloud(result, { clearDraft: true, action: null });
      if (state.activeId === targetId) state.tab = "overview";
      return;
    }
    const result =
      item.mode === "demo"
        ? applyDemoDecision(base, a.payload, action, item.draft.editedStatement)
        : await api("decision", {
            standing: base,
            assessment: a.payload,
            receipt: a.receipt,
            action,
            ...(action === "edit"
              ? {
                  edited_statement:
                    item.draft.editedStatement ??
                    a.payload.proposed_change.revised_statement,
                }
              : {}),
          });
    if (epoch !== requestEpoch) return;
    const selectedTab = state.tab,
      selectedId = state.activeId;
    state = applyWorkspaceDecision(state, targetId, a.id, result, now());
    if (selectedId !== targetId) state.tab = selectedTab;
  } catch (err) {
    if (epoch === requestEpoch) {
      const target = state.workspaces.find((x) => x.id === targetId);
      if (target)
        target.error = err.status === 409 && !["stale_assessment", "no_revision"].includes(err.message) ? "workspace_conflict" : failures[err.message] ? err.message : "invalid_input";
    }
  } finally {
    if (epoch === requestEpoch) {
      busy = null;
      save();
      render();
    }
  }
}
// Adopting the approved baseline: the server builds Standing v1 and records its lineage.
async function adoptBaseline() {
  captureDrafts();
  if (!cloud.user) { cloud.authOpen = true; cloud.error = ""; return render(true); }
  const own = findByTicker(state.workspaces, "NVDA");
  if (own) { state.activeId = own.id; return navigate("workspace", "overview", false); }
  const requestEpoch = epoch, requestNavigation = navigationEpoch;
  busy = { route: "adopt" };
  error = "";
  render();
  try {
    const result = await mutateCloud("adopt-baseline", "/api/workspaces/adopt-baseline", { language });
    if (!result) return;
    const item = putCloud(result);
    if (navigationEpoch === requestNavigation) { state.activeId = item.id; state.view = "workspace"; state.tab = "overview"; }
  } catch (err) {
    if (epoch === requestEpoch) error = failures[err.message] ? err.message : "cloud_unavailable";
  } finally {
    if (epoch === requestEpoch) { busy = null; save(); render(true); }
  }
}
// One click: start the server's check, then advance it step by step until no run is active.
async function runCheck() {
  captureDrafts();
  const targetId = w()?.id, requestEpoch = epoch;
  if (!targetId || !durable(w()) || blocked(w())) return;
  busy = { route: "check", workspaceId: targetId };
  delete checkErrors[targetId];
  render();
  try {
    for (let step = 0; step < 60; step++) {
      const current = state.workspaces.find((item) => item.id === targetId);
      if (!current) return;
      const result = await mutateCloud(`check:${targetId}`, `/api/workspaces/${encodeURIComponent(targetId)}/check`, {
        expected_revision: current.cloudRevision, expected_thesis_version: current.standing.version,
      }, targetId);
      if (!result || epoch !== requestEpoch) return;
      putCloud(result);
      if (!result.current_state.checks?.active) break;
      render();
    }
  } catch (err) {
    if (epoch === requestEpoch) {
      checkErrors[targetId] = failures[err.message] ? err.message : "cloud_unavailable";
      const target = state.workspaces.find((item) => item.id === targetId);
      if (target && CHECK_CODES.includes(err.message)) target.error = "";
    }
  } finally {
    if (epoch === requestEpoch) { busy = null; save(); render(); }
  }
}
async function confirmMonitoring() {
  const item = w(), requestEpoch = epoch;
  if (!item || !durable(item) || blocked(item)) return;
  busy = { route: "monitoring", workspaceId: item.id };
  delete checkErrors[item.id];
  render();
  try {
    const result = await mutateCloud(`monitoring:${item.id}`, `/api/workspaces/${encodeURIComponent(item.id)}/monitoring/confirm`, {
      expected_revision: item.cloudRevision, expected_thesis_version: item.standing.version,
    }, item.id);
    if (result) putCloud(result);
  } catch (err) {
    if (epoch === requestEpoch) checkErrors[item.id] = failures[err.message] ? err.message : "cloud_unavailable";
  } finally {
    if (epoch === requestEpoch) { busy = null; save(); render(); }
  }
}
async function showRun(runId) {
  const item = w();
  if (!item || !durable(item) || !/^chk_[0-9A-Za-z_]+$/.test(runId || "")) return;
  runDetails[runId] = { status: "loading" };
  render();
  try {
    const data = await cloud.connection.request(`/api/workspaces/${encodeURIComponent(item.id)}/checks/${encodeURIComponent(runId)}`);
    runDetails[runId] = { status: "open", data };
  } catch {
    runDetails[runId] = { status: "failed" };
  }
  render();
}
document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "language") {
    captureDrafts();
    language = target.dataset.language;
    try {
      localStorage.setItem(LANGUAGE_STORAGE, language);
    } catch {}
    save();
    render();
    document.querySelector(`[data-language="${language}"]`)?.focus();
    return;
  }
  if (
    busy &&
    !["home", "open", "tab", "clear", "close-action", "export", "signout"].includes(action)
  )
    return;
  try {
    if (action === "signin") { captureDrafts(); cloud.authOpen = true; cloud.error = ""; return render(true); }
    if (action === "close-auth") { captureDrafts(); cloud.authOpen = false; return render(); }
    if (action === "resend-auth") {
      cloud.authBusy = true;
      render();
      try { await cloud.connection.send(cloud.email); cloud.sent = true; cloud.error = ""; }
      catch { cloud.error = "auth_failed"; }
      finally { cloud.authBusy = false; render(); }
      return;
    }
    if (action === "signout") {
      // Invalidate replies before waiting for the provider to revoke this session.
      await authChanged(null);
      try { await cloud.connection.signOut(); }
      catch { cloud.authOpen = true; cloud.error = "auth_failed"; render(); }
      return;
    }
    if (action === "reload-cloud") { captureDrafts(); return await loadCloudWorkspaces(); }
    if (action === "reload-workspace") {
      const item = w(), requestEpoch = epoch;
      captureDrafts();
      busy = { route: "reload", workspaceId: item.id };
      render();
      try {
        const value = await cloud.connection.request(`/api/workspaces/${encodeURIComponent(item.id)}`);
        if (epoch === requestEpoch) { putCloud(value); cloud.failed = false; }
      } catch (err) { if (epoch === requestEpoch) cloudError(err, item.id); }
      finally { if (epoch === requestEpoch) { busy = null; save(); render(); } }
      return;
    }
    if (action === "import-cloud") {
      const item = importCandidates(anonymousState, cloud.imported).find((item) => item.id === target.dataset.id);
      if (!item || !cloud.user || cloud.loading || importConflict(item, state.workspaces)) return;
      const requestEpoch = epoch;
      busy = { route: "import" };
      try {
        const result = await mutateCloud(`import:${item.id}`, "/api/workspaces/import", { workspace: structuredClone(item) });
        if (!result) return;
        putCloud(result);
        cloud.imported[item.id] = result.id;
      } catch {} // The dedicated account banner contains the sanitized failure.
      finally { if (epoch === requestEpoch) { busy = null; save(); render(); } }
      return;
    }
    if (action === "archive-cloud") {
      const item = w(), requestEpoch = epoch;
      if (!durable(item) || blocked(item)) return;
      busy = { route: "archive", workspaceId: item.id };
      try {
        const result = await mutateCloud(`archive:${item.id}`, `/api/workspaces/${encodeURIComponent(item.id)}/archive`, {
          expected_revision: item.cloudRevision, expected_thesis_version: item.standing.version,
        }, item.id);
        if (result) putCloud(result);
      } catch {}
      finally { if (epoch === requestEpoch) { busy = null; save(); render(); } }
      return;
    }
    if (action === "adopt-baseline") return await adoptBaseline();
    if (action === "check-updates") return await runCheck();
    if (action === "confirm-monitoring") return await confirmMonitoring();
    if (action === "show-run") return await showRun(target.dataset.run);
    if (action === "hide-run") { delete runDetails[target.dataset.run]; return render(); }
    if (action === "baseline") return navigate("baseline");
    if (action === "replay") { replay.failed = false; return navigate("replay"); }
    if (action === "review-baseline") {
      captureDrafts();
      const own = findByTicker(state.workspaces, "NVDA");
      if (own) {
        // One workspace per ticker: adopting the baseline again just opens it.
        state.activeId = own.id;
        return navigate("workspace", "overview", false);
      }
      const standing = standingFromBaseline(language);
      state.creation = { token: id(), draft: { ticker: "NVDA", statement: standing.statement },
        proposal: standing, language, reviewDraft: {} };
      return navigate("create", "overview", false);
    }
    if (action === "home") return navigate("dashboard");
    if (action === "open") {
      captureDrafts();
      state.activeId = target.dataset.id;
      return navigate("workspace", "overview", false);
    }
    if (action === "tab") {
      navigate("workspace", target.dataset.tab);
      document.querySelector(`#tab-${state.tab}`).focus();
      return;
    }
    if (action === "create") {
      captureDrafts();
      state.creation.token ||= id();
      return navigate("create", "overview", false);
    }
    if (action === "clear") {
      if (cloud.user) {
        // Clearing drafts does not cancel an already-authorized account command.
        // Its server response still updates canonical state on the dashboard.
        if (busy?.route === "demo") { epoch++; busy = null; }
        navigationEpoch++;
        state.creation = { draft: {} };
        state.workspaces = state.workspaces.filter(durable);
        for (const item of state.workspaces) { item.draft = {}; item.action = null; }
        state.view = "dashboard";
        state.activeId = null;
        save();
        render(true);
        return;
      }
      epoch++;
      busy = null;
      cloud.saving = false;
      cloud.loading = false;
      state = freshSession();
      anonymousState = structuredClone(state);
      error = "";
      try {
        sessionStorage.removeItem(STORAGE);
        sessionStorage.removeItem(LEGACY_STORAGE);
      } catch {}
      return render(true);
    }
    if (action === "demo") return await startDemo();
    if (action === "restart-demo") return await startDemo(true);
    if (action === "back-define") {
      captureDrafts();
      delete state.creation.proposal;
      delete state.creation.reviewDraft;
      save();
      return render(true);
    }
    if (action === "new-evidence") {
      captureDrafts();
      w().action = "evidence";
      w().error = "";
      save();
      return render(true);
    }
    if (action === "close-action") {
      captureDrafts();
      w().action = null;
      save();
      return render();
    }
    if (action === "review") {
      w().action = "review";
      save();
      return render(true);
    }
    if (action === "reassess-record") {
      const item = w(), record = item.evidence.find((record) => record.id === target.dataset.id);
      if (!record || blocked(item)) return;
      captureDrafts();
      item.draft.evidence = structuredClone(record.content);
      item.action = "evidence";
      item.error = "";
      save();
      return render(true);
    }
    if (action === "reassess") {
      const item = w(),
        a = pending(item);
      item.draft.evidence = structuredClone(
        item.evidence.find((r) => r.id === a.evidenceId).content,
      );
      item.action = "evidence";
      item.error = "";
      save();
      return render(true);
    }
    if (action.startsWith("inject-")) return await inject(action.slice(7));
    if (action === "apply") return await applyDecision();
    if (action === "export") {
      captureDrafts();
      const item = w(),
        url = URL.createObjectURL(
          new Blob([JSON.stringify(item, null, 2)], {
            type: "application/json",
          }),
        ),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${item.standing.ticker}-standing-v${item.standing.version}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      return;
    }
  } catch (err) {
    error = failures[err.message] ? err.message : "service_error";
    render();
  }
});
document.addEventListener("keydown", (event) => {
  if (
    event.target.getAttribute("role") !== "tab" ||
    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
  )
    return;
  event.preventDefault();
  const tabs = ["overview", "evidence", "history"],
    index = tabs.indexOf(state.tab),
    next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? 2
          : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3;
  navigate("workspace", tabs[next]);
  document.querySelector(`#tab-${state.tab}`).focus();
});
document.addEventListener("input", () => {
  captureDrafts();
  save();
});
document.addEventListener("change", (event) => {
  if (event.target.name === "decision" && w()) {
    captureDrafts();
    w().draft.decision = event.target.value;
    save();
    render();
    document.querySelector(`input[value="${event.target.value}"]`)?.focus();
  }
});
document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target,
    values = Object.fromEntries(new FormData(form));
  if (form.id === "auth-form") {
    if (cloud.authBusy || !cloud.connection) return;
    cloud.email = values.email;
    cloud.otp = values.token || "";
    cloud.authBusy = true;
    cloud.error = "";
    render();
    try {
      if (cloud.sent && cloud.otp) await cloud.connection.verify(cloud.email, cloud.otp);
      else { await cloud.connection.send(cloud.email); cloud.sent = true; }
    } catch { cloud.error = "auth_failed"; }
    finally { cloud.authBusy = false; render(); }
    return;
  }
  if (busy || cloud.loading) return;
  captureDrafts();
  const requestEpoch = epoch,
    requestLanguage = language;
  let targetId = null,
    evidenceId = null;
  try {
    if (form.id === "drivers-form") {
      const s = state.creation.proposal,
        lines = (text) =>
          text
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
        standing = {
          ...structuredClone(s),
          statement: values.statement.trim(),
          falsifiers: lines(values.falsifiers),
          drivers: s.drivers.map((d, i) => ({
            ...d,
            title: values[`title-${i}`].trim(),
            statement: values[`driver-${i}`].trim(),
            what_to_watch: values[`watch-${i}`].trim(),
            falsifiers: lines(values[`falsifiers-${i}`]),
          })),
        };
      if (!validReviewStanding(standing)) throw new Error("invalid_input");
      const createPayload = {
        standing, authored: state.creation.draft.statement,
        language: state.creation.language || language,
      };
      // A retry of the same unfinished create resolves to the workspace it already made
      // (idempotency), so only a genuinely new second workspace is refused.
      if (findByTicker(state.workspaces, standing.ticker) &&
          !(cloud.user && mutationKeys.retrying("create", createPayload)))
        throw new Error("duplicate_ticker");
      if (cloud.user) {
        const requestNavigation = navigationEpoch;
        busy = { route: "create" };
        const result = await mutateCloud("create", "/api/workspaces", createPayload);
        if (!result) return;
        const item = putCloud(result);
        state.creation = { draft: {} };
        if (navigationEpoch === requestNavigation) {
          state.activeId = item.id;
          state.view = "workspace";
          state.tab = "overview";
        }
        return;
      }
      state = createWorkspace(state, {
        id: id(),
        standing,
        authored: state.creation.draft.statement,
        language: state.creation.language || language,
        time: now(),
      });
      save();
      return render(true);
    }
    if (form.id === "define-form") {
      // Checked before any model call: a second workspace for a ticker is never started.
      if (findByTicker(state.workspaces, values.ticker)) throw new Error("duplicate_ticker");
      const token = state.creation.token || (state.creation.token = id());
      busy = { route: "thesis" };
      error = "";
      save();
      render(true);
      const result = await api("thesis", {
        ...values,
        language: requestLanguage,
      });
      if (epoch !== requestEpoch || state.creation.token !== token) return;
      state.creation.proposal = result.standing;
      state.creation.language = requestLanguage;
      state.creation.reviewDraft = {};
    }
    if (form.id === "evidence-form") {
      const item = w(),
        base = structuredClone(item.standing);
      targetId = item.id;
      if (blocked(item)) return;
      if (durable(item)) {
        busy = { route: "evidence", workspaceId: targetId };
        item.error = "";
        const result = await mutateCloud(`assess:${targetId}`, `/api/workspaces/${encodeURIComponent(targetId)}/assess`, {
          evidence: values, language: requestLanguage,
          expected_revision: item.cloudRevision,
          expected_thesis_version: base.version,
        }, targetId);
        if (result) putCloud(result, { clearDraft: true, action: "review" });
        return;
      }
      evidenceId = id();
      state = registerEvidence(state, targetId, {
        id: evidenceId,
        evidence: values,
        time: now(),
      });
      busy = { route: "evidence", workspaceId: targetId };
      w().error = "";
      save();
      render(true);
      const result = await api("evidence", {
        standing: base,
        evidence: values,
        language: requestLanguage,
      });
      if (epoch !== requestEpoch) return;
      state = registerAssessment(state, targetId, {
        id: id(),
        evidenceId,
        assessment: result.assessment,
        receipt: result.receipt,
        language: requestLanguage,
        time: now(),
        baseStanding: base,
      });
    }
  } catch (err) {
    if (epoch === requestEpoch) {
      const code = failures[err.message] ? err.message : "service_error";
      if (targetId) {
        const target = state.workspaces.find((x) => x.id === targetId);
        if (target) {
          target.error = err.status === 409 && !["stale_assessment", "no_revision"].includes(err.message) ? "workspace_conflict" : code;
          const record = target.evidence.find((x) => x.id === evidenceId);
          if (record) record.status = "failed";
        }
      } else if (!cloud.user || code === "duplicate_ticker") error = code;
    }
  } finally {
    if (epoch === requestEpoch) {
      busy = null;
      save();
      render();
    }
  }
});
save();
render();
let releaseConnection;
const connectionReady = new Promise((resolve) => { releaseConnection = resolve; });
connectCloud((session) => { connectionReady.then(() => authChanged(session)); })
  .then((connection) => {
    cloud.connection = connection;
    cloud.available = !!connection;
    releaseConnection();
    captureDrafts();
    render();
  })
  .catch(() => { releaseConnection(); });
fetch("/api/health")
  .then((r) => (r.ok ? r.json() : Promise.reject()))
  .then((health) => {
    modelAvailable = health.custom_available;
    if (state.view === "create" && !busy) {
      captureDrafts();
      render();
    }
  })
  .catch(() => {
    modelAvailable = false;
    if (state.view === "create" && !busy) {
      captureDrafts();
      render();
    }
  });

fetch("/assets/build-info.json")
  .then(response => response.ok ? response.json() : Promise.reject())
  .then(info => {
    if (info.version !== "0.7.1" || !/^[a-f0-9]{40}$/.test(info.revision)) return;
    buildRevision = info.revision;
    document.querySelector(".footer-version").textContent = `v0.7.1 · Product Baseline · ${buildRevision.slice(0, 7)}`;
  }).catch(() => {});
