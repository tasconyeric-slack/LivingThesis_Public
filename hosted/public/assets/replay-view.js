import { translate } from "./i18n.js";
// Renders the exported recorded runs (replay-nvda.json). It never calls a model and never
// computes a conclusion: every value shown is copied from a committed Run Record or annotation.
const escape = value => String(value ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const helpers = language => ({ tr: (key, params) => escape(translate(language, key, params)) });
const RESULT = { relevant: "Relevant", irrelevant: "Irrelevant", uncertain: "Uncertain", blocked: "Blocked", rejected: "Rejected",
  watch_item_evidence: "Watch Item evidence", driver_context: "Driver context only" };
const RELATION = { support: "Support", weaken: "Weaken", contradict: "Contradict", unresolved: "Unresolved" };
const ACTION = { reaffirm: "Reaffirm · no revision proposed", keep_unresolved: "Keep unresolved · no revision proposed",
  propose_revision: "Revision proposed" };
const DECISION = { accept: "Accepted", edit: "Edited and accepted", reject: "Rejected", keep_unresolved: "Kept unresolved" };
const STAGE0 = { third_party_ownership_report: "Third-party ownership report", registration_or_offering_document: "Registration or offering document",
  unsupported_form_type: "Unsupported form type", duplicate_already_processed: "Already processed (same checksum)",
  outside_as_of_window: "Outside the as-of window", acquisition_failed: "Acquisition failed", eligible_issuer_document: "Eligible issuer document",
  malformed_acquisition: "Malformed acquisition" };
const ANNOTATION = { classification_superseded: "Classification superseded", model_factual_error: "Model error",
  model_overstatement: "Model overstatement", decision_request_withdrawn: "Decision request withdrawn", ungrounded_claim: "Not grounded in the shown text" };
const list = items => `<ul class="plain-list">${items.map(item => `<li>${item}</li>`).join("")}</ul>`;
const quote = text => `<blockquote class="preserve-text">${escape(text)}</blockquote>`;

export async function loadReplay() {
  const response = await fetch("/assets/replay-nvda.json", { cache: "no-store" });
  if (!response.ok) throw new Error("replay unavailable");
  return response.json();
}

export function funnel(run, tr) {
  const f = run.funnel, filtered = Object.values(f.stage0_filtered || {}).reduce((a, b) => a + b, 0);
  // Recorded v0.1 runs count "relevant"; v0.2 runs count direct Watch Item evidence.
  const positive = "watch_item_evidence" in f ? [f.watch_item_evidence, tr("Watch Item evidence → selective research")]
    : [f.relevant, tr("Relevant → selective research")];
  const steps = [[f.in_window, tr("NVIDIA filings in the window")], [filtered, tr("Filtered by code at Stage 0")],
    [f.stage0_kept, tr("Read by the Stage 1 relevance check")], positive, [f.proposals, tr("Revision proposals")]];
  return `<ol class="replay-funnel">${steps.map(([n, label]) => `<li><strong>${escape(n)}</strong><span>${label}</span></li>`).join("")}</ol>`;
}

function sources(event, tr) {
  return event.sources.map(s => `<p class="field-note"><a href="${escape(s.url)}" target="_blank" rel="noopener noreferrer">${escape(s.filename)} ↗</a> · SHA-256 <code>${escape(s.sha256.slice(0, 16))}…</code> · ${tr("Retrieved")} ${escape(s.retrieved_at)}</p>`).join("");
}

function scopeView(scope, tr) {
  return `<dl class="replay-dl"><dt>${tr("Affected drivers")}</dt><dd>${escape(scope.affected_driver_ids.join(", "))}</dd><dt>${tr("Affected Watch Items")}</dt><dd>${escape(scope.affected_watch_item_ids.join(", "))}</dd><dt>${tr("Research needs reopened")}</dt><dd>${tr("{count} of {total}", { count: scope.reopened_research_need_ids.length, total: scope.total_research_needs })} · ${escape(scope.reopened_research_need_ids.join(", "))}</dd><dt>${tr("Affected but monitoring gaps")}</dt><dd>${scope.gap_research_need_ids.length ? escape(scope.gap_research_need_ids.join(", ")) + " · " + tr("No connected source can research these; they stay open.") : tr("None")}</dd><dt>${tr("Not reopened")}</dt><dd>${tr("{count} research needs", { count: scope.skipped_research_need_ids.length })}</dd></dl>`;
}

function researchView(r, tr) {
  const diff = r.risk_factor_diff, xbrl = r.xbrl || { observations: [] };
  const obs = xbrl.observations.filter(o => o.status === "resolved");
  return `<h4>${tr("Deterministic research (code, not a model)")}</h4><p>${tr("{new} of {total} sentences in the filing's items are new relative to NVIDIA's prior 10-Q and 10-K.", { new: diff.new_sentence_count, total: diff.sentence_count })} <span class="field-note">${escape(diff.compared_with.map(c => `${c.form} ${c.accession}`).join(" · "))}</span></p><details><summary>${tr("New sentences")}</summary>${list(diff.new_sentences.map(escape))}</details>${obs.length ? `<p>${tr("XBRL context from the latest prior 10-Q")}:</p>${list(obs.map(o => `${escape(o.tag)} · ${escape(o.basis)} · ${escape(o.start ? o.start + " → " : "")}${escape(o.end)} · ${escape(Number(o.value).toLocaleString("en-US"))} ${escape(o.unit)} · ${escape(o.fiscal_period)} FY${escape(o.fiscal_year)}`))}` : ""}${(r.derived || []).length ? `<p>${tr("Derived ratios")}:</p>${list(r.derived.map(d => `${escape(d.formula)} = ${escape(d.percent)}%`))}` : ""}`;
}

function assessmentView(event, tr) {
  const w = event.what_changed, a = event.assessment;
  if (!w || !w.direction) return `<p class="alert">${tr("The model assessment did not pass validation and cannot be decided.")} ${escape((a?.validation_errors || []).join(", "))}</p>`;
  return `<h4>${tr("Model proposal (Stage 2)")}</h4><p><span class="pill amber">${tr(RELATION[w.direction])}</span> <span class="pill">${tr("Materiality")}: ${escape(w.materiality)}</span> <span class="pill green">${tr(ACTION[w.proposed_action])}</span></p><p class="field-note">${tr("Validation")}: ${escape(w.publish_status)} · ${tr("Quotes are verbatim matches to the stored filing; semantic entailment is not checked.")}</p><h5>${tr("What changed")}</h5>${list(w.what_changed.map(escape))}<h5>${tr("Driver impacts")}</h5>${w.driver_impacts.map(i => `<article class="replay-impact"><p><strong>${escape(i.driver_id)}</strong> · ${tr(RELATION[i.relation])} · ${tr("Materiality")}: ${escape(i.materiality)}</p><p>${escape(i.reasoning)}</p>${quote(i.exact_quote)}</article>`).join("")}<h5>${tr("Observed in the filing")}</h5>${list(w.observed_facts.filter(f => f.kind === "verbatim_quote").map(f => `${escape(f.statement)}${quote(f.exact_quote)}`))}<h5>${tr("Counter-reading")}</h5><p>${escape(w.counter_reading)}</p><h5>${tr("Uncertainties")}</h5>${list(w.uncertainties.map(escape))}<h5>${tr("Proposal")}</h5><p>${escape(w.proposal_reason)}</p>${w.proposed_delta ? `<p>${tr("Proposed statement")}:</p>${quote(w.proposed_delta.after)}` : ""}<h5>${tr("What to watch next")}</h5>${list(w.what_to_watch_next.map(escape))}`;
}

function decisionView(event, run, ctx, tr) {
  if (ctx.live) {
    // A live workspace run: the investor's own decision, read from the workspace, never an Owner decision.
    const live = ctx.liveDecision(event);
    if (live) return `<p class="replay-decision"><strong>${tr(live[0])}</strong>${live[1] ? `: ${tr(DECISION[live[1]])}` : ""}</p>`;
    if (event.decision_status === "no_decision_required") return `<p class="replay-decision">${tr("No Watch Item question was answered, so there is nothing to decide.")}</p>`;
    return "";
  }
  const decision = ctx.decisions.find(d => d.event_id === event.event_id && (!event.assessment?.assessment_id || d.assessment_id === event.assessment.assessment_id));
  if (decision) {
    const who = decision.actor.kind === "owner" ? tr("Owner decision") : tr("Automated test decision · not an Owner decision");
    return `<p class="replay-decision"><strong>${who}</strong>: ${tr(DECISION[decision.action])} · ${decision.changed ? `v${escape(decision.from_version)} → v${escape(decision.version)}` : tr("Standing v{version} retained", { version: decision.version })} · ${escape(decision.decided_at)}</p>`;
  }
  if (ctx.supersededBy(event, run)) return `<p class="replay-decision"><strong>${tr("Decision request withdrawn")}</strong>. ${tr("This assessment was superseded by a reassessment; no Owner decision is requested.")}</p>`;
  if (event.decision_status === "no_decision_required") return `<p class="replay-decision">${tr("No Watch Item question was answered, so there is nothing to decide.")}</p>`;
  if (event.decision_status === "awaiting_owner_decision")
    return ctx.scenario
      ? `<p class="replay-decision"><strong>${tr("Scenario only")}</strong>. ${tr("A decision here would apply to the scenario, never to the Owner's thesis. None is requested or recorded.")}</p>`
      : `<p class="replay-decision"><strong>${tr("Awaiting the Owner's decision")}</strong>. ${tr("No decision has been recorded. The Standing Thesis is unchanged.")}</p>`;
  return `<p class="replay-decision">${tr("No decision is possible for this event.")}</p>`;
}

function annotationsView(event, run, ctx, tr) {
  const notes = ctx.annotations.filter(a => a.run_id === run.run_id && a.event_id === event.event_id);
  if (!notes.length) return "";
  return `<section class="replay-annotations" aria-label="${tr("Annotations")}"><h4>${tr("Annotations on this record")}</h4>${notes.map(a => `<article class="replay-annotation" data-annotation="${escape(a.id)}"><p><span class="pill amber">${tr(ANNOTATION[a.kind] || a.kind)}</span> <code>${escape(a.pointer)}</code></p>${a.quoted ? `<p class="field-note">${tr("Recorded text")}: “${escape(a.quoted)}”</p>` : ""}<p>${escape(a.text)}</p><p class="field-note">${escape(a.author)} · ${escape(a.created_at)}${a.superseded_by_run_id ? ` · ${tr("Superseded by")} <code>${escape(a.superseded_by_run_id)}</code>` : ""}</p></article>`).join("")}<p class="field-note">${tr("The recorded model text above is unchanged; annotations are bound to the record's hash.")}</p></section>`;
}

function stage1View(event, tr) {
  const s1 = event.stage1 || {}, out = s1.output || {};
  if (!("effective" in s1)) {
    return `<h4>${tr("Stage 1 relevance")}</h4><p>${escape(out.rationale)}</p>${(s1.quote_bindings || []).map(b => quote(b.exact_quote)).join("")}${out.watch_item_ids?.length ? `<p class="field-note">${tr("Watch Items")}: ${escape(out.watch_item_ids.join(", "))}</p>` : ""}`;
  }
  const e = s1.effective;
  const answers = e.watch_item_answers.map(a => `<article class="replay-impact"><p><strong>${escape(a.watch_item_id)}</strong> · ${tr("answers")}: ${escape(a.answers)}</p>${quote(a.exact_quote)}</article>`).join("");
  const context = e.driver_context.map(n => `<article class="replay-impact"><p><strong>${escape(n.driver_id)}</strong> · ${tr("Driver context")}: ${escape(n.note)}</p>${quote(n.exact_quote)}</article>`).join("");
  const demoted = e.demoted_answers.length ? `<p class="alert">${tr("Demoted by code")}: ${escape(e.demoted_answers.map(d => `${d.watch_item_id} (${d.reasons.join(", ")})`).join("; "))}</p>` : "";
  return `<h4>${tr("Stage 1 Watch Item check")}</h4><p>${escape(out.rationale)}</p>${answers ? `<h5>${tr("Watch Item questions answered")}</h5>${answers}` : `<p class="field-note">${tr("No approved Watch Item question is answered by this filing.")}</p>`}${context ? `<h5>${tr("Driver context (no Watch Item answered)")}</h5>${context}` : ""}${demoted}<p class="field-note">${tr("Model classification")}: ${tr(RESULT[s1.model_classification] || s1.model_classification)} · ${tr("After code checks")}: ${tr(RESULT[s1.result])} · ${escape(s1.contract)}</p>`;
}

export function eventCard(event, run, ctx, language) {
  const { tr } = helpers(language), s1 = event.stage1 || {};
  const superseded = ctx.supersededBy(event, run);
  const positive = s1.result === "relevant" || s1.result === "watch_item_evidence";
  return `<article class="driver-card replay-event" data-event="${escape(event.event_id)}" data-run="${escape(run.run_id)}"><div class="card-top"><h3>${escape(event.form)} · ${escape(event.accession)}</h3><span class="pill result ${positive ? "amber" : ""}">${tr(RESULT[s1.result] || "Not assessed")}</span>${superseded ? `<span class="pill superseded">${tr("Superseded")}</span>` : ""}</div><p class="field-note">${tr("Filed")} ${escape(event.filing_date)} · ${tr("Accepted by EDGAR")} ${escape(event.timestamps.header_acceptance_utc)} (${tr("filing header, US Eastern → UTC")}) · ${tr("EDGAR index reads")} ${escape(event.timestamps.edgar_submissions_acceptance_raw)}</p>${sources(event, tr)}<h4>${tr("Stage 0")}</h4><p>${tr(STAGE0[event.stage0.reason] || event.stage0.reason)}</p>${stage1View(event, tr)}${event.research && !event.research.executed ? `<p class="field-note">${tr("Deep research calls")}: ${escape(event.research.deep_research_calls)} · ${tr("Stopped before research.")}</p>` : ""}${event.scope ? scopeView(event.scope, tr) : ""}${event.research?.executed ? researchView(event.research, tr) : ""}${event.what_changed || event.assessment?.publish_status ? assessmentView(event, tr) : ""}${annotationsView(event, run, ctx, tr)}${decisionView(event, run, ctx, tr)}</article>`;
}

function context(bundle, scenario = false) {
  const reassessments = bundle.runs.filter(r => r.supersedes);
  return { scenario, decisions: bundle.decisions || [], annotations: bundle.annotations || [],
    supersededBy: (event, run) => reassessments.find(r => r.supersedes.run_id === run.run_id && r.supersedes.event_id === event.event_id) };
}

function runSummary(run, tr) {
  const model = [...new Set(run.model_calls.map(c => c.response_model || c.requested_model))].join(", ") || tr("none");
  const tokens = typeof run.totals.tokens === "object" ? Object.entries(run.totals.tokens).map(([k, v]) => `${k} ${v}`).join(" · ") : run.totals.tokens;
  return `<dt>${tr("Model")}</dt><dd>${escape(model)} · ${tr("{count} model calls", { count: run.model_calls.length })} · ${tr("{count} deep-research call", { count: run.totals.deep_research_calls })} · ${escape(tokens)}</dd><dt>${tr("Run")}</dt><dd><code>${escape(run.run_id)}</code> · ${escape(run.run_at)} · ${tr("Record")} <code>${escape(run.record_sha256.slice(0, 12))}…</code></dd>`;
}

function repeatView(rerun, tr) {
  return `<section class="summary-card"><h2>${tr("Repeat check")}</h2><p>${tr("Run again at the same clock: {dupes} already-processed documents recognized by checksum, {calls} model calls, checkpoint {checkpoint}.", { dupes: rerun.events.filter(e => e.stage0.reason === "duplicate_already_processed").length, calls: rerun.totals.model_calls, checkpoint: rerun.checkpoint.reviewed_through_after })}</p><p class="field-note"><code>${escape(rerun.run_id)}</code></p></section>`;
}

function scenarioView(scenario, language) {
  const { tr } = helpers(language), ctx = context(scenario, true);
  const run = scenario.runs.find(r => r.events.some(e => e.stage0.result === "candidate")), rerun = scenario.runs.find(r => r !== run);
  const p = run.standing.provenance;
  return `<section class="replay-scenario" data-scenario="${escape(scenario.id)}"><p class="eyebrow">${tr("HISTORICAL T0 SCENARIO · NOT THE OWNER'S THESIS")}</p><h2>${tr("A filing that does answer a Watch Item")}</h2><p class="replay-banner" role="note">${tr("Separately labelled scenario. Its Standing reuses the approved Watch Item wording at an earlier date; it is not Owner-approved and never touches the live thesis.")}</p><dl class="replay-dl"><dt>${tr("Scenario Standing")}</dt><dd>${escape(run.standing.baseline_id)} · ${tr("not Owner-approved")} · <code>${escape(run.standing.baseline_content_sha256.slice(0, 12))}…</code></dd><dt>${tr("T0")}</dt><dd>${escape(p.effective_at)} · ${tr("reading cutoff {cutoff} · clock {asOf}", { cutoff: run.window.evidence_through, asOf: run.as_of })}</dd><dt>${tr("Why it exists")}</dt><dd>${escape(p.rationale)}</dd><dt>${tr("Hindsight")}</dt><dd>${escape(p.hindsight_note)}</dd><dt>${tr("Point-in-time rule")}</dt><dd>${escape(p.point_in_time_rule)} · ${tr("{count} later filings excluded", { count: run.window.excluded_after_as_of_count })}</dd>${runSummary(run, tr)}</dl>${funnel(run, tr)}<div class="replay-events">${run.events.map(event => eventCard(event, run, ctx, language)).join("")}</div>${rerun ? repeatView(rerun, tr) : ""}</section>`;
}

export function replayView(replay, language, button) {
  const { tr } = helpers(language);
  const run = replay.runs.find(r => !r.supersedes && r.events.some(e => e.stage0.result === "candidate"));
  const rerun = replay.runs.find(r => r !== run && !r.supersedes);
  const reassessment = replay.runs.find(r => r.supersedes);
  const ctx = context(replay);
  const correction = reassessment ? `<section class="replay-correction" role="note"><h2>${tr("Correction")}</h2><p>${tr("The first check classified the Hugging Face 8-K as relevant to W3.1 and W5.1. Checked against the exact Watch Item questions, it answers neither: an acquisition is not disclosed adoption loss, and restrictions on China-origin models are not constraints on NVIDIA's China sales. A reassessment at the same clock recorded it as driver context only. The original record is kept unchanged and annotated.")}</p><p class="field-note">${tr("No investment decision is requested for this event.")}</p></section>` : "";
  return `<div class="workspace-heading"><div><p class="eyebrow">NVIDIA · HISTORICAL REPLAY</p><h1>${tr("Check for Updates, replayed on real NVIDIA filings")}</h1><p>${tr("A recorded run of the check, with the clock set to {asOf}.", { asOf: run.as_of })}</p></div>${button("← NVIDIA Standing Thesis", "baseline", "quiet")}</div><p class="replay-banner" role="note">${tr("Real primary sources from SEC EDGAR, recorded once and replayed here. Viewing it makes no model call. This is separate from the synthetic demo.")}</p>${correction}<section class="standing-card"><h2>${tr("What was checked")}</h2><dl class="replay-dl"><dt>${tr("Standing Thesis")}</dt><dd>${escape(run.standing.baseline_id)} v${escape(run.standing.version)} · ${tr("Owner-approved baseline")} · <code>${escape(run.standing.baseline_content_sha256.slice(0, 12))}…</code></dd><dt>${tr("Window")}</dt><dd>${tr("Filed after the reading cutoff {cutoff}, and accepted by {asOf}", { cutoff: run.window.evidence_through, asOf: run.as_of })}</dd><dt>${tr("Acceptance time")}</dt><dd>${tr("Taken from each filing header (US Eastern, converted to UTC). EDGAR's submissions index reads 4 hours later for both documents; a filing counts only when both readings are before the clock.")}</dd><dt>${tr("Sources")}</dt><dd>${tr("NVIDIA SEC / EDGAR only. NVIDIA Investor Relations blocked automated access, so SEC filings were used.")}</dd>${runSummary(run, tr)}</dl>${funnel(run, tr)}<p class="field-note">${tr("Model-written text below is recorded in English and is not translated.")}</p></section><section class="replay-original"><div class="drivers-head"><h2>${tr("Documents that reached the relevance check")}</h2><span>${tr("{count} events", { count: run.events.length })}</span></div><div class="replay-events">${run.events.map(event => eventCard(event, run, ctx, language)).join("")}</div><details class="replay-noise"><summary>${tr("{count} filings removed at Stage 0 without a fetch or model call", { count: run.structural_noise.length })}</summary>${list(run.structural_noise.map(n => `${escape(n.form)} · ${escape(n.accession)} · ${escape(n.filing_date)} · ${tr(STAGE0[n.reason] || n.reason)}`))}</details></section>${rerun ? repeatView(rerun, tr) : ""}${reassessment ? `<section class="replay-reassessment"><h2>${tr("Reassessment")}</h2><p>${escape(reassessment.supersedes.reason)}</p><dl class="replay-dl">${runSummary(reassessment, tr)}<dt>${tr("Supersedes")}</dt><dd><code>${escape(reassessment.supersedes.run_id)}</code> · ${tr("Record")} <code>${escape(reassessment.supersedes.record_sha256.slice(0, 12))}…</code> · ${tr("unchanged")}</dd></dl><div class="replay-events">${reassessment.events.map(event => eventCard(event, reassessment, ctx, language)).join("")}</div></section>` : ""}${(replay.scenarios || []).map(s => scenarioView(s, language)).join("")}<section class="baseline-boundaries"><h2>${tr("Limits of this replay")}</h2>${list([
    tr("A handful of real events are an engineering demonstration, not an accuracy benchmark."),
    tr("Quotes are checked verbatim against the stored filing; whether they fully support the interpretation is not checked."),
    tr("A code check requires each claimed Watch Item answer to use that Watch Item's own terms; it can reject a weak link, but passing it does not prove the link."),
    tr("The model may know about events after the replay clock; its knowledge cutoff is not observable here."),
    tr("Customer, competitor and policy sources are not connected; those Watch Items remain monitoring gaps."),
    tr("Only the Owner can change the Standing Thesis. The live workspace has no automatic monitoring."),
  ])}</section>`;
}
