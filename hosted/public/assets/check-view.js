import { translate } from "./i18n.js";
import { eventCard, funnel as replayFunnel } from "./replay-view.js";
// Check for Updates in an adopted NVIDIA baseline workspace. Every value shown is server state:
// the browser never decides eligibility, relevance or outcomes; it only displays and asks.
const escape = value => String(value ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const helpers = language => ({ tr: (key, params) => escape(translate(language, key, params)) });
const OUTCOME = {
  no_new_material_evidence: ["No new material evidence", "green"],
  driver_context_only: ["Driver context only", ""],
  assessment_needs_review: ["Assessment needs your review", "amber"],
  partial_failure: ["Partial failure · retry", "amber"],
  incomplete_coverage: ["Incomplete coverage", "amber"],
};
const RESULT = { watch_item_evidence: "Watch Item evidence", driver_context: "Driver context only", irrelevant: "Irrelevant",
  uncertain: "Uncertain", rejected: "Rejected", blocked: "Blocked" };
const OUTCOME_EVENT = { held_pending_decision: "Waiting for your pending decision", acquisition_failed: "Acquisition failed",
  triage_blocked: "Relevance check failed", triage_rejected_needs_review: "Relevance result failed validation",
  assessment_blocked: "Assessment failed", assessed_rejected: "Assessment failed validation",
  assessment_contract_mismatch: "Assessment failed validation", malformed_acquisition: "Malformed acquisition" };
const MESSAGE = {
  no_new_material_evidence: "No filing in this window answered an approved Watch Item. Your Standing is unchanged. This is not proof that nothing happened: only NVIDIA's own SEC filings are read, and monitoring gaps remain.",
  driver_context_only: "Some filings relate to a driver but answer no approved Watch Item question, so nothing was researched further and there is nothing to decide.",
  assessment_needs_review: "A filing answered an approved Watch Item. Review the validated assessment and decide; your Standing changes only if you accept or edit.",
  partial_failure: "Some filings could not be checked or were held. The review checkpoint did not advance past them, so they will be checked again. Run Check for Updates again to retry.",
  incomplete_coverage: "No reviewed filing answered an approved Watch Item, but this review is incomplete: some filings could not be checked after repeated attempts. This is not a clean result, and the review checkpoint stays before them.",
};

// Display-only mirror of hosted/check_service.eligibility; the server enforces it.
export function checkStatus(item) {
  const lineage = item?.lineage;
  if (!lineage) return "not_eligible";
  const confirmed = lineage.monitoring.at(-1);
  if (confirmed.version !== item.standing.version) return "revalidation_required";
  return "eligible";
}

function when(value, language) {
  if (!value) return "—";
  return escape(new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })
    .format(new Date(value))) + " UTC";
}

function progress(active, tr) {
  const done = active.events.filter(e => e.stage0.result !== "filtered" || e.stage0.reason === "outside_as_of_window").length;
  return `<p role="status" class="loading">${tr("Checking NVIDIA SEC filings… {done} of {total} new filings processed", { done, total: done + active.queue.length })}</p>`;
}

function eventLine(event, tr) {
  const label = OUTCOME_EVENT[event.outcome] || RESULT[event.result] || "Not assessed";
  const kind = event.result === "watch_item_evidence" || event.failure || event.hold ? "amber" : "";
  const items = event.watch_item_ids.length ? `${tr("Watch Items")}: ${escape(event.watch_item_ids.join(", "))}` :
    event.driver_context_ids.length ? `${tr("Driver context")}: ${escape(event.driver_context_ids.join(", "))}` : "";
  return `<li class="check-event" data-accession="${escape(event.accession)}"><p><strong>${escape(event.form)}</strong> · ${event.url ? `<a href="${escape(event.url)}" target="_blank" rel="noopener noreferrer">${escape(event.accession)} ↗</a>` : escape(event.accession)} · ${tr("Filed")} ${escape(event.filing_date)} <span class="pill ${kind}">${tr(label)}</span></p>${items ? `<p class="field-note">${items}</p>` : ""}${event.rationale ? `<p>${escape(event.rationale)}</p>` : ""}${event.hold ? `<p class="field-note">${tr("Decide the pending assessment first; this filing is assessed against your resulting thesis on the next check.")}</p>` : ""}</li>`;
}

export function runResult(run, language) {
  const { tr } = helpers(language);
  const [label, kind] = OUTCOME[run.outcome] || ["Partial failure · retry", "amber"];
  const f = run.funnel, candidates = run.events.filter(e => e.stage0.result !== "filtered");
  const steps = [[f.in_window, "SEC filings in the window"], [f.stage0_filtered, "Filtered by code at Stage 0"],
    [f.stage0_kept + f.stage0_failed, "Read by the Stage 1 relevance check"], [f.watch_item_evidence + f.uncertain, "Watch Item evidence → selective research"],
    [f.assessments, "Assessments for your decision"]];
  return `<div class="check-result" data-run="${escape(run.run_id)}" data-outcome="${escape(run.outcome)}"><div class="card-top"><h3>${tr("Latest check")}</h3><span class="pill ${kind}">${tr(label)}</span></div><p>${tr(MESSAGE[run.outcome] || MESSAGE.partial_failure)}</p>${(run.window.unreviewed_after_repeated_failure || []).length ? `<p class="alert" role="note">${tr("{count} filings could not be checked after repeated attempts and are no longer retried automatically. They are not covered by this review; read them on SEC EDGAR.", { count: run.window.unreviewed_after_repeated_failure.length })} ${escape(run.window.unreviewed_after_repeated_failure.map(x => `${x.form} ${x.accession}`).join(" · "))}</p>` : ""}${run.stopped === "thesis_changed" ? `<p class="alert" role="note">${tr("Your thesis changed during this check, so it stopped before assessing the remaining filings against the new version.")}</p>` : ""}<ol class="replay-funnel">${steps.map(([n, key]) => `<li><strong>${escape(n)}</strong><span>${tr(key)}</span></li>`).join("")}</ol>${candidates.length ? `<ul class="plain-list check-events">${candidates.map(e => eventLine(e, tr)).join("")}</ul>` : `<p class="field-note">${tr("No new NVIDIA filing needed a relevance check.")}</p>`}<dl class="replay-dl"><dt>${tr("Checked at")}</dt><dd>${when(run.run_at, language)}</dd><dt>${tr("Filings accepted by")}</dt><dd>${when(run.as_of, language)}</dd><dt>${tr("Reviewed through")}</dt><dd>${run.reviewed_through_after ? when(run.reviewed_through_after, language) : tr("Not advanced by this check")}</dd><dt>${tr("Window starts after")}</dt><dd>${escape(run.window.evidence_through)} · ${tr("the approved baseline's source reading cutoff")}</dd><dt>${tr("Checked against")}</dt><dd>${tr("Standing v{version}", { version: run.standing_version })}</dd><dt>${tr("Model use")}</dt><dd>${tr("{count} model calls", { count: run.totals.model_calls })} · ${tr("{count} deep-research call", { count: run.totals.deep_research_calls })}${typeof run.totals.tokens === "object" && Object.keys(run.totals.tokens).length ? ` · ${escape(Object.entries(run.totals.tokens).map(([k, v]) => `${k} ${v}`).join(" · "))}` : ""}</dd></dl></div>`;
}

export function lineageNote(item, language) {
  const { tr } = helpers(language), lineage = item.lineage;
  return `<p class="field-note check-lineage">${tr("Adopted from the Owner-approved NVIDIA baseline")} <code>${escape(lineage.baseline_content_sha256.slice(0, 12))}…</code> · ${when(lineage.adopted_at, language)} · ${tr("Approved monitoring rules: 5 drivers · 13 Watch Items (5 observable from NVIDIA disclosures, 8 monitoring gaps) · confirmed for Standing v{version}", { version: lineage.monitoring.at(-1).version })}</p>`;
}

export function checkCard(item, { language, button, busy, error, alert }) {
  const { tr } = helpers(language);
  if (!item.lineage) {
    if (item.standing.ticker !== "NVDA" || item.mode !== "custom") return "";
    return `<section class="work-card check-card check-unavailable" aria-labelledby="check-heading"><h2 id="check-heading">${tr("Check for Updates")}</h2><p>${tr("Check for Updates is available only for a workspace adopted from the Owner-approved NVIDIA baseline. This workspace was created from text confirmed in a browser, so its link to the approved monitoring rules cannot be verified. Your thesis and its history are unchanged.")}</p><p class="field-note">${tr("To use it, archive this workspace and adopt the approved baseline from the NVIDIA Standing Thesis page.")}</p></section>`;
  }
  const status = checkStatus(item), checks = item.checks || {}, active = checks.active, runs = checks.runs || [];
  const running = busy?.route === "check" && busy.workspaceId === item.id;
  const action = status === "revalidation_required"
    ? `<div class="alert" role="alert">${tr("Your thesis is now Standing v{version}. The approved monitoring rules were confirmed for v{confirmed}. Confirm they still apply to your revised thesis before checking.", { version: item.standing.version, confirmed: item.lineage.monitoring.at(-1).version })}</div>${button("Confirm monitoring rules for v{version}", "confirm-monitoring", "primary", !!busy, "", { version: item.standing.version })}`
    : button(active ? "Continue check" : "Check for Updates", "check-updates", "primary", !!busy);
  return `<section class="work-card check-card" aria-labelledby="check-heading"><div class="card-top"><h2 id="check-heading">${tr("Check for Updates")}</h2>${action}</div><p>${tr("Reads NVIDIA's new SEC EDGAR filings now, filters them by code, tests the rest against the approved Watch Items and researches only what they answer. It runs only when you click it.")}</p>${running && active ? progress(active, tr) : running ? `<p role="status" class="loading">${tr("Listing NVIDIA SEC filings…")}</p>` : ""}${!running && active ? `<p class="field-note">${tr("A check started at {time} is unfinished. Continue it; nothing already checked is repeated.", { time: when(active.run_at, language) })}</p>` : ""}${error ? alert(error) : ""}${runs.length ? runResult(runs.at(-1), language) : `<p class="field-note">${tr("Not checked yet. The first check reads filings made after the baseline's source reading cutoff.")}</p>`}${lineageNote(item, language)}</section>`;
}

export function checkHistory(item, details, { language, button }) {
  if (!item.lineage) return "";
  const { tr } = helpers(language);
  const runs = (item.checks?.runs || []).slice().reverse();
  const confirmations = item.lineage.monitoring.map(m => `<li>${m.basis === "adoption" ? tr("Monitoring rules adopted with Standing v1") : tr("Monitoring rules reconfirmed for Standing v{version}", { version: m.version })} · ${when(m.time, language)}</li>`).join("");
  return `<section class="check-history" aria-labelledby="check-history-heading"><h2 id="check-history-heading">${tr("Check for Updates runs")}</h2><p class="field-note">${tr("Each run is saved with its sources, hashes, model calls and validation. Fixture data is never shown here.")}</p><ul class="plain-list">${confirmations}</ul>${runs.length ? runs.map(run => {
    const [label] = OUTCOME[run.outcome] || ["Partial failure · retry"];
    const detail = details[run.run_id];
    return `<article class="version-record check-run" data-run="${escape(run.run_id)}"><h3>${when(run.run_at, language)} · ${tr(label)}</h3><p class="field-note"><code>${escape(run.run_id)}</code> · ${tr("Record")} <code>${escape(run.record_sha256.slice(0, 12))}…</code> · ${tr("Standing v{version}", { version: run.standing_version })} · ${tr("{count} model calls", { count: run.totals.model_calls })}</p>${detail?.status === "open" ? button("Hide run record", "hide-run", "quiet", false, `data-run="${escape(run.run_id)}"`) + runRecordView(detail.data, item, language) : button(detail?.status === "loading" ? "Loading run record…" : "Show run record", "show-run", "secondary", detail?.status === "loading", `data-run="${escape(run.run_id)}"`)}${detail?.status === "failed" ? `<p class="alert" role="alert">${tr("The run record could not be loaded. Try again.")}</p>` : ""}</article>`;
  }).join("") : `<p>${tr("No check has run yet.")}</p>`}</section>`;
}

function runRecordView(record, item, language) {
  const { tr } = helpers(language);
  const ok = record.integrity.complete ? record.integrity.part_digests_match && record.integrity.record_sha256_matches : true;
  const decisions = item.decisions || [];
  const ctx = { scenario: false, live: true, annotations: [], decisions: [], supersededBy: () => null,
    liveDecision: event => {
      const assessment = item.assessments.find(a => a.check?.event_id === event.event_id && a.check?.run_id === record.run_id);
      const decision = assessment && decisions.find(d => d.assessmentId === assessment.id);
      return decision ? ["Decision recorded", decision.action] : assessment ? ["Awaiting your decision", null] : null;
    } };
  const run = { run_id: record.run_id, funnel: record.funnel };
  return `<div class="check-record"><p class="${ok ? "field-note" : "alert"}">${tr(ok ? "Integrity verified: every saved part matches the run's recorded hashes." : "Integrity check failed: a saved part does not match the recorded hashes.")}</p>${replayFunnel(run, (key, params) => escape(translate(language, key, params)))}<div class="replay-events">${record.events.filter(e => e.stage0.result !== "filtered").map(event => eventCard(event, run, ctx, language)).join("")}</div><details class="replay-noise"><summary>${tr("{count} filings removed at Stage 0 without a model call", { count: record.events.filter(e => e.stage0.result === "filtered").length })}</summary><ul class="plain-list">${record.events.filter(e => e.stage0.result === "filtered").map(e => `<li>${escape(e.form)} · ${escape(e.accession)} · ${escape(e.filing_date)} · ${escape(e.stage0.reason)}</li>`).join("")}</ul></details><p class="field-note">${tr("Model-written text is recorded in English and is not translated.")}</p></div>`;
}

// Provenance of a filing the server acquired (evidence list and decision panel).
export function acquisitionNote(record, language) {
  const { tr } = helpers(language), a = record?.acquisition;
  if (!a) return "";
  return `<p class="field-note check-source"><span class="pill green">${tr("Retrieved from SEC EDGAR by the server")}</span> ${escape(a.form)} · <a href="${escape(a.sources[0].url)}" target="_blank" rel="noopener noreferrer">${escape(a.accession)} ↗</a> · ${tr("Filed")} ${escape(a.filing_date)} · ${tr("Accepted by EDGAR")} ${escape(a.accepted_at)} · SHA-256 <code>${escape(a.sources[0].sha256.slice(0, 16))}…</code></p><p class="field-note">${tr("Quotes are verbatim matches to the retrieved filing; semantic entailment is not checked.")}</p>`;
}

export function checkAssessmentExtras(a, language) {
  const c = a.check;
  if (!c) return "";
  const { tr } = helpers(language);
  const answers = c.watch_item_answers.map(x => `<li><strong>${escape(x.watch_item_id)}</strong> · ${escape(x.answers)}<blockquote class="preserve-text">${escape(x.exact_quote)}</blockquote></li>`).join("");
  return `<div class="check-extras"><h3>${tr("Watch Item questions answered")}</h3><ul class="plain-list">${answers || `<li>${tr("Uncertain")}: ${escape(c.uncertain_watch_item_ids.join(", "))}</li>`}</ul><p>${tr("Materiality")}: ${escape(c.materiality)} · ${tr("Research needs reopened")}: ${tr("{count} of {total}", { count: c.scope.reopened_research_need_ids.length, total: c.scope.total_research_needs })} (${escape(c.scope.reopened_research_need_ids.join(", "))})${c.scope.gap_research_need_ids.length ? ` · ${tr("Affected but monitoring gaps")}: ${escape(c.scope.gap_research_need_ids.join(", "))}` : ""}</p><h3>${tr("Counter-reading")}</h3><p>${escape(c.counter_reading)}</p><h3>${tr("Uncertainties")}</h3><ul class="plain-list">${c.uncertainties.map(u => `<li>${escape(u)}</li>`).join("")}</ul><p class="field-note">${tr("Model")}: ${escape(c.model.response_model || c.model.requested_model)} · ${tr("Run")} <code>${escape(c.run_id)}</code> · ${tr("Model-written text is recorded in English and is not translated.")}</p></div>`;
}
