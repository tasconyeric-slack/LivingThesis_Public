"""Authenticated NVIDIA Check for Updates for an adopted baseline workspace.

One click runs a bounded, resumable check across several short requests (Vercel allows 60 s):

  start  EDGAR submissions -> window after the durable checkpoint -> Stage 0 by metadata (no fetch,
         no model). Already-processed filings are recognised by accession without a fetch.
  step   exactly one model stage for one filing: acquisition + Stage 1 triage, or re-acquisition
         (same checksum required) + deterministic research + Stage 2 assessment.
  finish checkpoint advances only if every filing in the window reached an outcome; a filing excluded
         after repeated failure stays unreviewed, holds the checkpoint and is reported on every run.

Each request commits through the existing workspace transaction (owner scope, revision CAS,
idempotency), so a lost response or a crash retries safely and nothing is half-written. The check
core is backend/src/living_thesis/evidence_check.py, the same code path as the recorded replay.
No canonical state is written to the local filesystem.
"""
from __future__ import annotations

import asyncio
import os
import secrets
import time
from copy import deepcopy
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Callable

from pydantic import ValidationError

from backend.src.living_thesis import evidence_check as ec
from . import baseline_lineage, service
from .durable_service import _event, _stamp, append_assessment, content_digest, validate_concurrency, validate_state
from .models import Assessment, Standing

SCHEMA = "workspace-checks-0.1"
MAX_CANDIDATES_PER_RUN = 8      # filings that may reach Stage 1 in one run; the rest wait for the next run
MAX_RUN_SUMMARIES = 50          # in the workspace; full Run Record parts stay in workspace_events
MAX_PERIODIC_REFS = 12
MODEL_TIMEOUT_SECONDS = 35.0
SEC_TIMEOUT_SECONDS = 12.0
EXECUTOR = "hosted_authenticated_api"
ELIGIBILITY_MESSAGES = {
    "not_eligible": ("check_not_eligible", "Check for Updates is available only for a workspace adopted from the "
                     "Owner-approved NVIDIA baseline."),
    "mapping_invalid": ("monitoring_mapping_invalid", "This thesis no longer matches the approved drivers and Watch "
                        "Items, so automated checks are unavailable."),
    "revalidation_required": ("monitoring_revalidation_required", "Your thesis changed. Confirm that the approved "
                              "monitoring rules still apply to this version before checking."),
    "rules_changed": ("monitoring_rules_changed", "The approved monitoring rules on this server differ from the ones this "
                      "workspace adopted, so automated checks are paused. Your thesis and history are unchanged."),
}
STEP_BUDGET_SECONDS = 22.0      # no model call starts later than this into a request (Vercel stops at 60 s)


class DeadlineTransport:
    """Refuses to start a model call that could not finish inside the function limit; the filing is retried."""

    def __init__(self, inner, deadline: float):
        self.inner, self.deadline = inner, deadline
        self.executor = getattr(inner, "executor", EXECUTOR)

    def run(self, stage, context, standing=None):
        if time.monotonic() > self.deadline:
            raise ec.CheckError("time_budget_exceeded", "Not enough time left in this request for a model call.")
        return self.inner.run(stage, context, standing)


# ---------------------------------------------------------------- runtime (server-side only)

@dataclass
class Runtime:
    sec: object
    transport: object
    clock: Callable[[], datetime]


def runtime() -> Runtime:
    """SEC access and the model key are server configuration; neither ever comes from a browser."""
    agent = os.environ.get("SEC_USER_AGENT", "").strip()
    if not agent or "@" not in agent:
        raise service.ProductError("check_unavailable", "Check for Updates is not configured on this server yet.", 503)
    key = service.api_key()
    from backend.src.living_thesis.sec_client import SecClient
    sec = SecClient(agent, timeout=SEC_TIMEOUT_SECONDS, max_attempts=2, backoff=0.5)
    transport = ec.DeepSeekTransport(key, timeout=MODEL_TIMEOUT_SECONDS)
    transport.executor = EXECUTOR
    return Runtime(sec, transport, lambda: datetime.now(timezone.utc))


class HostedStore:
    """The check core's store interface without a filesystem: originals are identified by URL and SHA-256."""
    root = None

    def __init__(self, standing: dict):
        self._state = {"versions": [{"standing": deepcopy(standing)}]}

    def write_source(self, accession, filename, data):
        return None

    def load_state(self, standing):
        return self._state


# ---------------------------------------------------------------- eligibility and monitoring rules

def eligibility(state: dict) -> str:
    lineage = state.get("lineage")
    if not lineage:
        return "not_eligible"
    if lineage["check_standing_sha256"] != baseline_lineage.check_standing_sha256():
        return "rules_changed"
    if baseline_lineage.monitoring_rules(state["standing"]) != baseline_lineage.monitoring_rules(state["versions"][0]["standing"]):
        return "mapping_invalid"
    confirmed = lineage["monitoring"][-1]
    if confirmed["version"] != state["standing"]["version"] or \
            confirmed["statement_sha256"] != baseline_lineage.digest(state["standing"]["statement"]):
        return "revalidation_required"
    return "eligible"


def require_eligible(state: dict) -> None:
    status = eligibility(state)
    if status != "eligible":
        code, message = ELIGIBILITY_MESSAGES[status]
        raise service.ProductError(code, message, 409)


def confirm_monitoring(workspace, request, now=None):
    """The investor reconfirms that the approved monitoring rules apply to their revised Standing."""
    state = validate_concurrency(workspace, request)["current_state"]
    status = eligibility(state)
    if status in {"not_eligible", "mapping_invalid", "rules_changed"}:
        code, message = ELIGIBILITY_MESSAGES[status]
        raise service.ProductError(code, message, 409)
    if status == "eligible":
        raise service.ProductError("monitoring_already_confirmed", "The monitoring rules are already confirmed for this version.", 409)
    events = _stop_stale_run(state, now)
    stamp = _stamp(now)
    entry = {"version": state["standing"]["version"], "statement_sha256": baseline_lineage.digest(state["standing"]["statement"]),
             "basis": "investor_confirmed", "time": stamp}
    state["lineage"]["monitoring"].append(entry)
    state["updatedAt"] = stamp
    validate_state(state)
    return state, events + [_event("monitoring_confirmed", confirmation=deepcopy(entry),
                          baseline_content_sha256=state["lineage"]["baseline_content_sha256"],
                          rules="5 drivers, 8 falsifiers and 13 Watch Items of the approved baseline, unchanged")]


def check_standing_for(state: dict) -> dict:
    """What the model is shown: the approved projection, with the investor's current statement after a revision.

    Drivers, falsifiers and Watch Items always come from the approved baseline (verified unchanged)."""
    approved = ec.load_standing()
    if state["standing"]["version"] == 1:
        return approved
    derived = deepcopy(approved)
    derived["statement"] = state["standing"]["statement"]
    derived["version"] = state["standing"]["version"]
    derived["hosted_standing"] = deepcopy(state["standing"])
    derived["workspace_derivation"] = {
        "from_check_standing_sha256": ec.standing_sha256(approved),
        "rule": "Statement replaced by the investor's current Standing; drivers, falsifiers and Watch Items are the "
                "approved baseline's, reconfirmed by the investor for this version."}
    return derived


# ---------------------------------------------------------------- check state helpers

def new_checks() -> dict:
    standing = ec.load_standing()
    checkpoint = ec.new_checkpoint(standing)
    checkpoint.pop("standing_sha256")   # per workspace; each processed entry names its own run and version
    return {"schema_version": SCHEMA, "checkpoint": checkpoint, "active": None, "runs": []}


def _ref(data: dict) -> ec.FilingRef:
    return ec.FilingRef(**data)


def _usage_add(total: dict | None, calls: list[dict]) -> dict | None:
    if total is None:
        return None
    out = dict(total)
    for call in calls:
        usage = call.get("usage")
        if not usage:
            return None
        for key, value in usage.items():
            out[key] = out.get(key, 0) + value
    return out


def compact(event: dict, assessment_id: str | None = None) -> dict:
    """What the workspace keeps per filing; the full event is in the Run Record (workspace_events)."""
    s1 = event.get("stage1") or {}
    effective = s1.get("effective") or {}
    sources = event.get("sources") or []
    a = event.get("assessment") if isinstance(event.get("assessment"), dict) else {}
    return {"event_id": event["event_id"], "accession": event["accession"], "form": event["form"],
            "filing_date": event["filing_date"],
            "accepted_at": (event.get("timestamps") or {}).get("header_acceptance_utc"),
            "url": sources[0]["url"] if sources else None,
            "stage0": {"result": event["stage0"]["result"], "reason": event["stage0"].get("reason")},
            "result": s1.get("result"), "outcome": event.get("outcome"),
            "rationale": (s1.get("output") or {}).get("rationale"),
            "watch_item_ids": [x["watch_item_id"] for x in effective.get("watch_item_answers", [])],
            "uncertain_watch_item_ids": effective.get("uncertain_watch_item_ids", []),
            "driver_context_ids": sorted({n["driver_id"] for n in effective.get("driver_context", [])}),
            "gap_watch_item_ids": effective.get("gap_watch_item_ids", []),
            "deep_research_calls": (event.get("research") or {}).get("deep_research_calls", 0),
            "publish_status": a.get("publish_status"), "assessment_id": assessment_id,
            "failure": event.get("failure"), "hold": event.get("hold")}


# ---------------------------------------------------------------- advance: start or one step

def _stop_stale_run(state: dict, now=None) -> list[dict]:
    """A run bound to an earlier Standing version never continues; it is closed without any fetch or model call."""
    active = (state.get("checks") or {}).get("active")
    if not active or active["standing_version"] == state["standing"]["version"]:
        return []
    active["stopped"] = "thesis_changed"
    return [_finish(state, lambda: now or datetime.now(timezone.utc))]


async def advance(workspace, request, rt: Runtime | None = None):
    current = validate_concurrency(workspace, request)
    state = current["current_state"]
    stopped = _stop_stale_run(state)
    if stopped:
        state["updatedAt"] = _stamp()
        validate_state(state)
        return state, stopped
    require_eligible(state)
    rt = rt or runtime()
    checks = state.get("checks") or new_checks()
    state["checks"] = checks
    started = time.perf_counter()
    if checks["active"] is None:
        events = await asyncio.to_thread(_start, state, rt)
    else:
        events = await asyncio.to_thread(_step, state, rt)
    active = checks["active"]
    if active is not None:
        active["elapsed_ms"] += int((time.perf_counter() - started) * 1000)
        active["steps"] += 1
        if not active["queue"] or active.get("stopped"):
            events.append(_finish(state, rt.clock))
    state["updatedAt"] = _stamp(rt.clock())
    validate_state(state)
    return state, events


def _start(state: dict, rt: Runtime) -> list[dict]:
    checks = state["checks"]
    checkpoint = checks["checkpoint"]
    run_at = rt.clock().astimezone(timezone.utc).replace(microsecond=0)
    as_of = run_at
    approved = ec.load_standing()
    if as_of < ec.parse_utc(baseline_lineage.approval_recorded_at()) or \
            as_of.date() <= datetime.fromisoformat(approved["evidence_through"]).date():
        raise service.ProductError("check_unavailable", "The approved baseline is not yet effective at this time.", 409)
    try:
        submissions = rt.sec.submissions(ec.NVDA_CIK)
        refs = ec.filings_from_submissions(submissions)
    except (KeyError, IndexError, TypeError, ValueError, AttributeError):
        raise service.ProductError("sec_malformed", "SEC EDGAR returned an unexpected response. Nothing was changed; try again.", 502) from None
    except Exception:
        raise service.ProductError("sec_unavailable", "SEC EDGAR could not be reached. Nothing was changed; try again.", 502) from None
    basis = checkpoint["initial_basis"]["evidence_through"]
    if not any(r.filing_date <= basis for r in refs):
        # The listing must reach back to the window start; an empty or truncated list proves nothing.
        raise service.ProductError("sec_malformed", "SEC EDGAR returned an incomplete filing list. Nothing was changed; try again.", 502)
    standing = check_standing_for(state)
    run_id = f"chk_{run_at.strftime('%Y%m%dT%H%M%SZ')}_{secrets.token_hex(3)}"
    after_basis = [r for r in refs if r.filing_date > basis]
    try:
        in_window = sorted((r for r in after_basis if ec.available_by(r, as_of)), key=lambda r: (r.submissions_acceptance, r.accession))
        excluded = [r.accession for r in after_basis if not ec.available_by(r, as_of)]
    except (TypeError, ValueError):
        raise service.ProductError("sec_malformed", "SEC EDGAR returned an unexpected response. Nothing was changed; try again.", 502) from None
    filtered, queue, exceptions = [], [], []
    for ref in in_window:
        event = {"event_id": ref.event_id, "accession": ref.accession, "form": ref.form, "filing_date": ref.filing_date,
                 "report_date": ref.report_date or None, "items": ref.items or None,
                 "timestamps": {"edgar_submissions_acceptance_raw": ref.submissions_acceptance}}
        previous = checkpoint["processed"].get(ref.event_id)
        if ref.form in ec.THIRD_PARTY_OWNERSHIP_FORMS:
            event["stage0"] = {"result": "filtered", "reason": "third_party_ownership_report"}
        elif ref.form in ec.REGISTRATION_FORMS:
            event["stage0"] = {"result": "filtered", "reason": "registration_or_offering_document"}
        elif ref.form not in ec.ISSUER_REPORT_FORMS:
            event["stage0"] = {"result": "filtered", "reason": "unsupported_form_type"}
        elif previous:
            # EDGAR accessions are immutable; a processed filing is not fetched or assessed again.
            event["stage0"] = {"result": "filtered", "reason": "duplicate_already_processed",
                               "first_run_id": previous["run_id"], "note": "Recognised by accession; not re-fetched."}
        elif (checkpoint["failures"].get(ref.event_id) or {}).get("status") == "failed_permanent":
            # Failed MAX_FAILURE_ATTEMPTS times: excluded from automatic retries so it cannot crowd out new
            # filings or cost a model call every run. It is listed as unreviewed on every run.
            exceptions.append({"accession": ref.accession, "form": ref.form, "filing_date": ref.filing_date,
                               "last_error": checkpoint["failures"][ref.event_id]["last_error"]})
            continue
        else:
            queue.append({"ref": asdict(ref), "phase": "triage", "event": None})
            continue
        filtered.append(event)
    deferred = [entry["ref"]["accession"] for entry in queue[MAX_CANDIDATES_PER_RUN:]]
    queue = queue[:MAX_CANDIDATES_PER_RUN]
    periodic = sorted((r for r in refs if r.form in ec.PERIODIC_FORMS), key=lambda r: r.filing_date, reverse=True)
    window = {"rule": "filing_date > evidence_through and every acceptance reading <= as_of; processed accessions skipped",
              "evidence_through": basis, "as_of": ec.utc(as_of), "submissions_retrieved_at": ec.utc(run_at),
              "submissions_filings_listed": len(refs), "excluded_after_as_of": excluded,
              "deferred_to_next_check": deferred, "unreviewed_after_repeated_failure": exceptions}
    started_payload = {"run_id": run_id, "run_at": ec.utc(run_at), "as_of": ec.utc(as_of), "ticker": ec.TICKER,
                       "cik": ec.NVDA_CIK, "standing_version": state["standing"]["version"],
                       "check_standing_sha256": ec.standing_sha256(standing),
                       "baseline_content_sha256": state["lineage"]["baseline_content_sha256"],
                       "approval_recorded_at": state["lineage"]["approval_recorded_at"],
                       "window": window, "events": filtered, "queue": [q["ref"]["accession"] for q in queue],
                       "checkpoint_before": checkpoint["reviewed_through"],
                       "prompts": {stage: {"contract": ec.CURRENT_STAGES[stage], "sha256": ec.sha256_text(ec.prompt_text(stage))}
                                   for stage in ec.STAGES},
                       "environment": {"executor": EXECUTOR, "extractor": ec.EXTRACTOR_VERSION,
                                       "code_revision": os.environ.get("VERCEL_GIT_COMMIT_SHA") or None,
                                       "sec_user_agent": "configured (contact redacted)",
                                       "model_knowledge_cutoff": "not observable; contamination probe deferred",
                                       "sources": "NVIDIA SEC EDGAR only (NVIDIA IR blocks automated access)"}}
    state["checks"]["active"] = {
        "run_id": run_id, "run_at": ec.utc(run_at), "as_of": ec.utc(as_of), "standing_version": state["standing"]["version"],
        "check_standing_sha256": ec.standing_sha256(standing), "window": window,
        "periodic": [asdict(r) for r in periodic[:MAX_PERIODIC_REFS]], "queue": queue,
        "events": [], "filtered_by_reason": {reason: sum(e["stage0"]["reason"] == reason for e in filtered)
                                             for reason in sorted({e["stage0"]["reason"] for e in filtered})},
        "digests": [content_digest(started_payload)],
        "model_calls": 0, "triage_calls": 0, "deep_research_calls": 0, "tokens": {}, "errors": [],
        "assessment_ids": [], "steps": 0, "elapsed_ms": 0, "checkpoint_before": checkpoint["reviewed_through"],
        "stopped": None}
    return [_event("check_started", **started_payload)]


def _step(state: dict, rt: Runtime) -> list[dict]:
    active = state["checks"]["active"]
    checkpoint = state["checks"]["checkpoint"]
    if active["standing_version"] != state["standing"]["version"]:
        # Never assess against a Standing that changed mid-run; the rest waits for a new check.
        active["stopped"] = "thesis_changed"
        return []
    entry = active["queue"][0]
    ref = _ref(entry["ref"])
    standing = check_standing_for(state)
    if ec.standing_sha256(standing) != active["check_standing_sha256"]:
        active["stopped"] = "thesis_changed"
        return []
    transport = DeadlineTransport(rt.transport, time.monotonic() + STEP_BUDGET_SECONDS)
    check = ec.EvidenceCheck(rt.sec, HostedStore(state["standing"]), transport, standing=standing, clock=rt.clock)
    as_of = ec.parse_utc(active["as_of"])
    phase = entry["phase"]
    try:
        return _process(state, rt, check, entry, ref, as_of)
    except service.ProductError:
        raise
    except Exception as exc:
        # Recorded as a retryable failure for this filing (attempt counted), never a stuck run.
        event = deepcopy(entry["event"]) if entry["event"] else {
            "event_id": ref.event_id, "accession": ref.accession, "form": ref.form, "filing_date": ref.filing_date,
            "timestamps": {"edgar_submissions_acceptance_raw": ref.submissions_acceptance},
            "stage0": {"result": "candidate", "reason": "eligible_issuer_document"}}
        event["outcome"] = "step_failed"
        event["step_error"] = getattr(exc, "reason", None) or getattr(exc, "code", None) or type(exc).__name__
        checkpoint["processed"].pop(ref.event_id, None)
        check._record_processed(event, checkpoint, active["run_id"], "step_failed", terminal=False)
        active["queue"].pop(0)
        active["events"].append(compact(event))
        return [_record_stage(active, _stage_payload(active, phase, event, check.model_calls, held=False), check)]


def _process(state, rt, check, entry, ref, as_of) -> list[dict]:
    active, checkpoint = state["checks"]["active"], state["checks"]["checkpoint"]
    assessment_id, extra_events, phase = None, [], entry["phase"]
    if phase == "triage":
        event, held = check._event_triage(ref, as_of, checkpoint, active["run_id"])
        if held is not None:
            entry.update(phase="assess", event=event)
            payload = _stage_payload(active, "triage", event, check.model_calls, held=True)
            return [_record_stage(active, payload, check)]
    else:
        event = deepcopy(entry["event"])
        if state["pendingId"] is not None:
            event["outcome"] = "held_pending_decision"
            event["hold"] = {"reason": "pending_decision",
                             "note": "Decide the pending assessment first; this filing is assessed against the resulting "
                                     "thesis on the next check. The checkpoint does not advance past it."}
        else:
            event = _assess(check, event, ref, as_of, checkpoint, active)
            if event.get("outcome") == "assessed_validated":
                assessment_id, extra_events = _add_assessment(state, check, event, active, rt)
    active["queue"].pop(0)
    active["events"].append(compact(event, assessment_id))
    if assessment_id:
        active["assessment_ids"].append(assessment_id)
    payload = _stage_payload(active, phase, event, check.model_calls, held=False, assessment_id=assessment_id)
    return [_record_stage(active, payload, check), *extra_events]


def _assess(check, event, ref, as_of, checkpoint, active) -> dict:
    try:
        acquired = check._acquire(ref)
    except Exception as exc:
        code = getattr(exc, "code", None) or getattr(exc, "reason", None) or type(exc).__name__
        event["assessment"] = {"result": "blocked", "reason": "acquisition_failed", "error": str(code)}
        event["outcome"] = "assessment_blocked"
        return check._record_processed(event, checkpoint, active["run_id"], event["outcome"], terminal=False)
    if acquired["content_checksum"] != event["content_checksum"]:
        event["assessment"] = {"result": "blocked", "reason": "source_changed_between_steps"}
        event["outcome"] = "assessment_blocked"
        return check._record_processed(event, checkpoint, active["run_id"], event["outcome"], terminal=False)
    held = {"acquired": acquired, "triage": event["stage1"]["output"], "effective": event["stage1"]["effective"]}
    refs = [_ref(r) for r in active["periodic"]]
    return check._event_assess(event, ref, refs, as_of, checkpoint, active["run_id"], held)


def _add_assessment(state, check, event, active, rt):
    """A validated filing assessment becomes the workspace's pending assessment (human decision required)."""
    record = event["assessment"]
    shown = check.last_assess_documents
    view = ec.hosted_assessment_view(record["assessment"])
    try:
        payload = Assessment.model_validate(view).model_dump(mode="json")
    except ValidationError:
        key = event["event_id"].split("#")[0]
        state["checks"]["checkpoint"]["processed"].pop(key, None)
        event["outcome"] = "assessment_contract_mismatch"
        check._record_processed(event, state["checks"]["checkpoint"], active["run_id"], event["outcome"], terminal=False)
        return None, []
    source_text = "\n\n".join(d["text"] for d in shown)[:50000]
    call = next(c for c in check.model_calls if c["call_id"] == record["model_call_id"])
    items = f" · Items {event['items']}" if event.get("items") else ""
    primary = event["sources"][0]
    content = {"event_date": event["filing_date"],
               "information": f"NVIDIA {event['form']} filed {event['filing_date']} (SEC accession {event['accession']}){items}",
               "source": f"SEC EDGAR · {event['form']} · {event['accession']} · {primary['url']}"[:1000],
               "source_text": source_text, "language": "en"}
    acquisition = {"origin": "sec_edgar_check", "run_id": active["run_id"], "event_id": event["event_id"],
                   "accession": event["accession"], "form": event["form"], "filing_date": event["filing_date"],
                   "accepted_at": event["timestamps"].get("header_acceptance_utc"), "items": event.get("items"),
                   "sources": [{k: s.get(k) for k in ("source_id", "filename", "url", "sha256", "bytes", "retrieved_at", "text_sha256")}
                               for s in event["sources"]],
                   "content_checksum": event["content_checksum"], "shown_text_sha256": ec.sha256_text(source_text)}
    a = record["assessment"]
    check_block = {"run_id": active["run_id"], "event_id": event["event_id"], "accession": event["accession"],
                   "standing_version": state["standing"]["version"], "check_standing_sha256": active["check_standing_sha256"],
                   "materiality": a["materiality"], "counter_reading": a["counter_reading"], "uncertainties": a["uncertainties"],
                   "observed_facts": a["observed_facts"],
                   "driver_impacts": [{k: i[k] for k in ("driver_id", "relation", "materiality")} for i in a["driver_impacts"]],
                   "proposed_action": ec.PROPOSED_ACTION[a["proposed_change"]["action"]],
                   "watch_item_answers": event["stage1"]["effective"]["watch_item_answers"],
                   "uncertain_watch_item_ids": event["stage1"]["effective"]["uncertain_watch_item_ids"],
                   "scope": event["scope"], "evidence_bindings": record["evidence"],
                   "assessment_sha256": record["assessment_sha256"], "publish_status": record["publish_status"],
                   "payload_sha256": content_digest(payload),
                   "model": {k: call.get(k) for k in ("requested_model", "response_model", "usage", "latency_ms",
                                                       "prompt_sha256", "context_sha256", "raw_output_sha256", "executor")},
                   "semantic_entailment_checked": False}
    receipt = service.sign(Standing.model_validate(state["standing"]), Assessment.model_validate(payload))
    evidence, assessment = append_assessment(state, content, payload, receipt, "en", _stamp(rt.clock()),
                                             acquisition=acquisition, check=check_block)
    return assessment["id"], [_event("evidence_added", evidence=deepcopy(evidence)),
                              _event("assessment_created", assessment=deepcopy(assessment), source_verified=False,
                                     source_acquired_by_server=True, semantic_entailment_checked=False)]


def _stage_payload(active, phase, event, calls, held, assessment_id=None) -> dict:
    return {"run_id": active["run_id"], "step": active["steps"] + 1, "phase": phase, "event_id": event["event_id"],
            "held_for_assessment": held, "event": deepcopy(event), "model_calls": deepcopy(calls),
            "workspace_assessment_id": assessment_id}


def _record_stage(active, payload, check) -> dict:
    calls = check.model_calls
    active["model_calls"] += len(calls)
    active["triage_calls"] += sum(c["stage"] == "triage" for c in calls)
    active["deep_research_calls"] += sum(c["stage"] == "assess" for c in calls)
    active["tokens"] = _usage_add(active["tokens"], calls)
    active["errors"] += check.errors
    active["digests"].append(content_digest(payload))
    return _event("check_stage_recorded", **payload)


def _finish(state: dict, clock) -> dict:
    checks = state["checks"]
    active = checks["active"]
    checkpoint = checks["checkpoint"]
    retryable = sorted({e["event_id"] for e in active["events"] if e.get("failure") or e.get("hold")}
                       | {f"edgar:{a}" for a in active["window"]["deferred_to_next_check"]}
                       | {f"edgar:{q['ref']['accession']}" for q in active["queue"]})
    exceptions = active["window"]["unreviewed_after_repeated_failure"]
    unreviewed = sorted(f"edgar:{x['accession']}" for x in exceptions)
    # A filing excluded after repeated failure was never reviewed: it blocks the checkpoint exactly like
    # a retryable failure (so reviewed_through never claims coverage of it), but it is not retried.
    blocked = sorted(set(retryable) | set(unreviewed))
    updated = ec.advance_checkpoint(checkpoint, active["as_of"], active["run_id"], blocked)
    updated["history"] = updated["history"][-100:]
    checks["checkpoint"] = updated
    events = active["events"]
    stage1 = lambda value: sum(e.get("result") == value for e in events)
    filtered = sum(active["filtered_by_reason"].values())
    funnel = {"in_window": filtered + len(events) + len(active["queue"]) + len(active["window"]["deferred_to_next_check"])
              + len(exceptions),
              "stage0_kept": sum(e["stage0"]["result"] == "candidate" for e in events),
              "stage0_filtered": filtered, "stage0_filtered_by_reason": active["filtered_by_reason"],
              "unreviewed_after_repeated_failure": len(exceptions),
              "stage0_failed": sum(e["stage0"]["result"] == "failed" for e in events),
              "watch_item_evidence": stage1("watch_item_evidence"), "driver_context": stage1("driver_context"),
              "uncertain": stage1("uncertain"), "irrelevant": stage1("irrelevant"), "rejected": stage1("rejected"),
              "assessments": len(active["assessment_ids"]), "deferred": len(active["window"]["deferred_to_next_check"]),
              "not_reached": len(active["queue"])}
    if retryable or active["stopped"]:
        outcome = "partial_failure"
    elif active["assessment_ids"]:
        outcome = "assessment_needs_review"
    elif unreviewed:
        # Never a clean "no new material evidence" or "driver context only" over an unreviewed filing.
        outcome = "incomplete_coverage"
    elif funnel["driver_context"]:
        outcome = "driver_context_only"
    else:
        outcome = "no_new_material_evidence"
    completed_at = ec.utc(clock())
    summary = {"run_id": active["run_id"], "run_at": active["run_at"], "completed_at": completed_at, "as_of": active["as_of"],
               "standing_version": active["standing_version"], "check_standing_sha256": active["check_standing_sha256"],
               "outcome": outcome, "stopped": active["stopped"], "funnel": funnel, "events": events,
               "window": {k: active["window"][k] for k in ("evidence_through", "as_of", "submissions_filings_listed",
                                                          "deferred_to_next_check", "unreviewed_after_repeated_failure")},
               "reviewed_through_before": active["checkpoint_before"], "reviewed_through_after": updated["reviewed_through"],
               "blocked_by": blocked, "assessment_ids": active["assessment_ids"],
               "coverage": {"complete": not blocked and not active["stopped"], "unreviewed": unreviewed,
                            "retry_next_run": retryable},
               "totals": {"model_calls": active["model_calls"], "triage_calls": active["triage_calls"],
                          "deep_research_calls": active["deep_research_calls"],
                          "tokens": active["tokens"] if active["tokens"] is not None else "not fully observed",
                          "cost": "not measured (provider pricing not verified)",
                          "server_ms": active["elapsed_ms"], "requests": active["steps"]},
               "errors": active["errors"],
               "reaffirmation": ({"reviewed_through": updated["reviewed_through"],
                                  "note": "No filing answered an approved Watch Item; the Standing is unchanged."}
                                 if outcome in {"no_new_material_evidence", "driver_context_only"} else None)}
    record_sha256 = content_digest({"summary": summary, "parts": active["digests"]})
    summary["record_sha256"] = record_sha256
    checks["runs"] = (checks["runs"] + [summary])[-MAX_RUN_SUMMARIES:]
    checks["active"] = None
    return _event("check_completed", run_id=summary["run_id"], summary=deepcopy(summary),
                  part_digests=list(active["digests"]), record_sha256=record_sha256)


# ---------------------------------------------------------------- Run Record (read back and verified)

def run_record(rows: list[dict], run_id: str) -> dict:
    """Join the run's events in sequence order and verify each part against the recorded digests."""
    started = next((r["payload"] for r in rows if r["event_type"] == "check_started"), None)
    if started is None:
        raise service.ProductError("check_run_not_found", "This check run is unavailable.", 404)
    stages = [r["payload"] for r in rows if r["event_type"] == "check_stage_recorded"]
    completed = next((r["payload"] for r in rows if r["event_type"] == "check_completed"), None)
    parts = [content_digest(started)] + [content_digest(p) for p in stages]
    integrity = {"parts": len(parts), "complete": completed is not None}
    if completed is not None:
        integrity["part_digests_match"] = parts == completed["part_digests"]
        integrity["record_sha256_matches"] = content_digest(
            {"summary": {k: v for k, v in completed["summary"].items() if k != "record_sha256"},
             "parts": completed["part_digests"]}) == completed["record_sha256"]
    final = {}
    for stage in stages:
        final[stage["event_id"]] = stage["event"]
    events = started["events"] + [final[e] for e in dict.fromkeys(s["event_id"] for s in stages)]
    return {"run_id": run_id, "started": {k: v for k, v in started.items() if k != "events"},
            "events": events, "model_calls": [c for s in stages for c in s["model_calls"]],
            "funnel": ec.run_funnel(events), "summary": completed["summary"] if completed else None,
            "record_sha256": completed["record_sha256"] if completed else None, "integrity": integrity,
            "fixture": False}
