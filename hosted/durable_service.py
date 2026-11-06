"""Authoritative domain transitions; the repository owns transaction/CAS/idempotency.

These helpers never write storage and never accept replacement state for a mutation.
The model call happens before the repository's final compare-and-swap transaction.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import uuid

from pydantic import ValidationError

from . import baseline_lineage, service
from .durable_models import DurableWorkspaceState, ImportWorkspaceRequest, WorkspaceRecord
from .models import AssessRequest, DecisionRequest


UI_FIELDS = {"action", "draft", "error"}


def _json(value):
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json")
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def content_digest(value):
    return hashlib.sha256(_json(value).encode("utf-8")).hexdigest()


def import_snapshot(workspace):
    """Only known transient v0.6.1 UI fields may be discarded from an import."""
    return {key: deepcopy(value) for key, value in workspace.items() if key not in UI_FIELDS}


def import_digest(workspace):
    return content_digest(import_snapshot(workspace))


def request_digest(request, operation):
    payload = request.model_dump(mode="json", exclude={"idempotency_key"})
    if isinstance(request, ImportWorkspaceRequest):
        payload["workspace"] = import_snapshot(payload["workspace"])
    return content_digest({"operation": operation, "request": payload})


def _stamp(now=None):
    if now is None:
        return datetime.now(timezone.utc).isoformat()
    if isinstance(now, datetime):
        return now.isoformat()
    return now


def _event(event_type, **payload):
    return {"event_type": event_type, "payload": payload}


def _bad(message="The workspace could not be validated. Your saved thesis is unchanged."):
    raise service.ProductError("invalid_workspace", message, 422)


def _preserved(raw, normalized):
    """Reject coercion/normalization of supplied imported investment artifacts."""
    if isinstance(raw, dict):
        return isinstance(normalized, dict) and all(
            key in normalized and _preserved(value, normalized[key]) for key, value in raw.items())
    if isinstance(raw, list):
        return isinstance(normalized, list) and len(raw) == len(normalized) and all(
            _preserved(a, b) for a, b in zip(raw, normalized))
    return type(raw) is type(normalized) and raw == normalized


def validate_state(state):
    """Validate bounds, artifact graph, exact grounding and supported history replay."""
    try:
        parsed = DurableWorkspaceState.model_validate(state)
        if not _preserved(state, parsed.model_dump(mode="json")):
            _bad()
        snapshots = {v.standing.version: v.standing.model_dump(mode="json") for v in parsed.versions}
        if len(snapshots) != len(parsed.versions):
            _bad()
        for previous, current in zip(parsed.versions, parsed.versions[1:]):
            before, after = previous.standing.model_dump(mode="json"), current.standing.model_dump(mode="json")
            expected = {**before, "statement": after["statement"], "version": before["version"] + 1}
            if before["statement"] == after["statement"] or after != expected:
                _bad()
        if parsed.versions[-1].standing != parsed.standing:
            _bad()

        evidence = {record.id: record for record in parsed.evidence}
        assessments = {record.id: record for record in parsed.assessments}
        decisions = {record.assessmentId: record for record in parsed.decisions if record.assessmentId is not None}
        if len(evidence) != len(parsed.evidence) or len(assessments) != len(parsed.assessments):
            _bad()
        if len(decisions) != sum(record.assessmentId is not None for record in parsed.decisions):
            _bad()
        legacy = isinstance(parsed.history[0].type, str) and parsed.history[0].type == "legacy"
        if any(record.type in {"created", "legacy"} for record in parsed.history[1:]):
            _bad()
        if parsed.history[0].type not in {"created", "legacy"}:
            _bad()
        if not legacy and (parsed.versions[0].standing.version != 1 or parsed.history[0].version != 1):
            _bad()
        if not legacy and (parsed.history[0].time != parsed.versions[0].time
                           or parsed.createdAt != parsed.versions[0].time):
            _bad()

        pending = [record.id for record in parsed.assessments if record.status == "pending"]
        if pending != ([parsed.pendingId] if parsed.pendingId is not None else []):
            _bad()
        for record in parsed.evidence:
            if record.assessmentId is None:
                if record.status not in {"pending", "failed"}:
                    _bad()
            elif record.assessmentId not in assessments or assessments[record.assessmentId].evidenceId != record.id:
                _bad()
        for record in parsed.assessments:
            source = evidence.get(record.evidenceId)
            if source is None or source.assessmentId != record.id:
                _bad()
            expected_status = {"pending": "assessed", "superseded": "superseded",
                               "decided": "decided", "unresolved": "unresolved"}[record.status]
            if source.status != expected_status:
                _bad()
            base = record.baseStanding.model_dump(mode="json")
            if snapshots.get(record.baseStanding.version) != base:
                _bad()
            allowed = {driver.driver_id for driver in record.baseStanding.drivers}
            if any(impact.driver_id not in allowed or impact.exact_quote not in source.content.source_text
                   or not impact.exact_quote.strip() for impact in record.payload.driver_impacts):
                _bad()
            raw_source = next(item["content"] for item in state["evidence"] if item["id"] == source.id)
            if record.evidenceDigest is not None and record.evidenceDigest != content_digest(raw_source):
                _bad()
            if record.status == "pending" and (not record.receipt or record.imported or base != parsed.standing.model_dump(mode="json")):
                _bad()
            decision = decisions.get(record.id)
            if record.status in {"decided", "unresolved"}:
                if decision is None and not (legacy and record.time is None):
                    _bad()
                if decision and ((record.status == "unresolved") != (decision.action == "keep_unresolved")):
                    _bad()
            elif decision is not None:
                _bad()

        legacy_decisions = [record for record in parsed.decisions if record.assessmentId is None]
        if legacy:
            if any(record.time is not None for record in legacy_decisions):
                _bad()
            expected = [{"action": item.decision, "changed": item.changed, "version": item.version}
                        for item in parsed.history[0].records]
            actual = [{"action": item.action, "changed": item.changed, "version": item.version}
                      for item in legacy_decisions]
            if actual != expected:
                _bad()
            if any(record.changed and record.action not in {"accept", "edit"}
                   or record.fromVersion != record.version - int(record.changed)
                   or record.version > parsed.standing.version for record in legacy_decisions):
                _bad()
            # Older migration can retain only a suffix of the original history;
            # do not invent its first baseline, but every retained step must chain.
            if any(current.fromVersion != previous.version
                   for previous, current in zip(legacy_decisions, legacy_decisions[1:])):
                _bad()
        elif legacy_decisions:
            _bad()
        cursor = (legacy_decisions[-1].version if legacy_decisions else parsed.versions[0].standing.version)
        if cursor not in snapshots:
            _bad()
        seen_assessments, seen_decisions = set(), set()
        legacy_open = [record.id for record in parsed.assessments if legacy and record.time is None
                       and (record.status == "pending" or record.importedOriginalStatus == "pending")]
        if len(legacy_open) > 1:
            _bad()
        active_assessment = legacy_open[0] if legacy_open else None
        for item in parsed.history[1:]:
            if item.type == "assessed":
                record = assessments.get(item.assessmentId)
                if record is None or item.assessmentId in seen_assessments or item.evidenceId != record.evidenceId:
                    _bad()
                if item.version != cursor or record.baseStanding.version != cursor or item.time != record.time:
                    _bad()
                seen_assessments.add(item.assessmentId)
                active_assessment = item.assessmentId
            elif item.type == "decision":
                decision = decisions.get(item.assessmentId)
                record = assessments.get(item.assessmentId)
                if decision is None or record is None or item.assessmentId in seen_decisions:
                    _bad()
                if item.assessmentId not in seen_assessments and not (legacy and record.time is None):
                    _bad()
                if active_assessment != item.assessmentId:
                    _bad()
                if any(getattr(item, key) != getattr(decision, key)
                       for key in ("action", "changed", "fromVersion", "version", "time")):
                    _bad()
                if decision.fromVersion != cursor or record.baseStanding.version != cursor:
                    _bad()
                if decision.version != cursor + int(decision.changed):
                    _bad()
                if decision.changed and decision.action not in {"accept", "edit"}:
                    _bad()
                after = snapshots.get(decision.version)
                if after is None or decision.statement != after["statement"]:
                    _bad()
                if decision.changed != (snapshots[cursor]["statement"] != decision.statement):
                    _bad()
                if decision.changed and next(v for v in parsed.versions if v.standing.version == decision.version).time != decision.time:
                    _bad()
                if decision.action in {"accept", "edit"}:
                    if not record.payload.relevant or record.payload.proposed_change.action != "revise":
                        _bad()
                    if decision.action == "accept" and decision.statement != record.payload.proposed_change.revised_statement:
                        _bad()
                cursor = decision.version
                seen_decisions.add(item.assessmentId)
                active_assessment = None
        if cursor != parsed.standing.version or seen_decisions != set(decisions):
            _bad()
        if parsed.pendingId is not None and active_assessment != parsed.pendingId:
            _bad()
        if any(record.id not in seen_assessments and not (legacy and record.time is None)
               for record in parsed.assessments):
            _bad()
        if legacy and (state.get("lineage") is not None or state.get("checks") is not None):
            _bad()
        baseline_lineage.validate(state)
        return deepcopy(state)
    except (ValidationError, ValueError, KeyError, TypeError, AttributeError):
        _bad()


def _workspace(workspace):
    raw = workspace.model_dump(mode="json", exclude_unset=True) if isinstance(workspace, WorkspaceRecord) else deepcopy(workspace)
    try:
        WorkspaceRecord.model_validate(raw)
    except (ValidationError, ValueError, TypeError):
        _bad()
    validate_state(raw["current_state"])
    return raw


def validate_concurrency(workspace, request):
    current = _workspace(workspace)
    if current.get("archived_at") is not None:
        raise service.ProductError("workspace_archived", "This thesis has been archived.", 409)
    if current["revision"] != request.expected_revision or current["active_thesis_version"] != request.expected_thesis_version:
        raise service.ProductError("stale_workspace", "This thesis changed in another session. Refresh it before continuing.", 409)
    return current


def create_workspace(request, workspace_id=None, now=None):
    stamp, identifier = _stamp(now), workspace_id or str(uuid.uuid4())
    standing = request.standing.model_dump(mode="json")
    state = {"id": identifier, "mode": "custom", "standing": standing, "authored": request.authored,
             "language": request.language, "createdAt": stamp, "updatedAt": stamp,
             "versions": [{"standing": deepcopy(standing), "time": stamp}], "evidence": [],
             "assessments": [], "decisions": [], "pendingId": None,
             "history": [{"type": "created", "version": 1, "time": stamp}]}
    validate_state(state)
    return state, [_event("workspace_created", standing=deepcopy(standing), authored=request.authored,
                          language=request.language)]


def pending_assessment(state):
    return next((record for record in state["assessments"] if record["id"] == state["pendingId"]), None)


def append_assessment(state, content, payload, receipt, language, stamp, acquisition=None, check=None):
    """Add evidence and its pending assessment. Shared by manual evidence and Check for Updates."""
    evidence_id, assessment_id = str(uuid.uuid4()), str(uuid.uuid4())
    if state["pendingId"]:
        old = pending_assessment(state)
        old["status"] = "superseded"
        next(record for record in state["evidence"] if record["id"] == old["evidenceId"])["status"] = "superseded"
    evidence = {"id": evidence_id, "content": content, "time": stamp, "event": None,
                "sourceVerified": False, "synthetic": False, "status": "assessed", "assessmentId": assessment_id,
                **({"acquisition": acquisition} if acquisition else {})}
    assessment = {"id": assessment_id, "evidenceId": evidence_id, "payload": payload,
                  "receipt": receipt, "language": language, "time": stamp,
                  "baseStanding": deepcopy(state["standing"]), "status": "pending",
                  "evidenceDigest": content_digest(content), "imported": False, **({"check": check} if check else {})}
    state["evidence"].append(evidence)
    state["assessments"].append(assessment)
    state["pendingId"], state["updatedAt"] = assessment_id, stamp
    state["history"].append({"type": "assessed", "assessmentId": assessment_id, "evidenceId": evidence_id,
                             "version": state["standing"]["version"], "time": stamp})
    return evidence, assessment


async def assess_workspace(workspace, request, now=None):
    current = validate_concurrency(workspace, request)
    state = current["current_state"]
    pending = pending_assessment(state)
    if pending and pending.get("check"):
        # A filing assessment from Check for Updates is never silently superseded by pasted evidence.
        raise service.ProductError("check_assessment_pending",
                                   "Decide the pending SEC filing assessment before analyzing other evidence.", 409)
    response = await service.assess(AssessRequest(standing=state["standing"], evidence=request.evidence,
                                                language=request.language))
    content = request.evidence.model_dump(mode="json")
    evidence, assessment = append_assessment(state, content, response["assessment"], response["receipt"],
                                             request.language, _stamp(now))
    validate_state(state)
    return state, [_event("evidence_added", evidence=deepcopy(evidence)),
                   _event("assessment_created", assessment=deepcopy(assessment),
                          source_verified=False, semantic_entailment_checked=False)]


def decide_workspace(workspace, request, now=None):
    current = validate_concurrency(workspace, request)
    state = current["current_state"]
    assessment = next((record for record in state["assessments"] if record["id"] == request.assessment_id), None)
    if assessment is None or state["pendingId"] != request.assessment_id or assessment["status"] != "pending" or assessment.get("imported"):
        raise service.ProductError("stale_assessment", "Assess this evidence again before deciding.", 409)
    if assessment["baseStanding"] != state["standing"]:
        raise service.ProductError("stale_assessment", "Your thesis changed. Assess the evidence again before deciding.", 409)
    evidence = next(record for record in state["evidence"] if record["id"] == assessment["evidenceId"])
    if assessment.get("evidenceDigest") != content_digest(evidence["content"]):
        raise service.ProductError("stale_assessment", "The evidence changed. Assess it again before deciding.", 409)
    receipt = assessment["receipt"]
    if assessment.get("check"):
        # A Check for Updates assessment never left the server: it is bound by its payload digest (verified
        # with the state), the current Standing and the acquired filing's digest, not by a key-derived,
        # expiring receipt. Re-signing here keeps it decidable after a day or a server key rotation.
        if assessment["check"].get("payload_sha256") != content_digest(assessment["payload"]):
            raise service.ProductError("stale_assessment", "The assessment changed. Run Check for Updates again.", 409)
        from .models import Assessment, Standing
        receipt = service.sign(Standing.model_validate(state["standing"]), Assessment.model_validate(assessment["payload"]))
    response = service.decide(DecisionRequest(standing=state["standing"], assessment=assessment["payload"],
                                            receipt=receipt, action=request.action,
                                            edited_statement=request.edited_statement))
    stamp, before = _stamp(now), deepcopy(state["standing"])
    state["standing"] = response["standing"]
    assessment["status"] = "unresolved" if request.action == "keep_unresolved" else "decided"
    evidence["status"] = assessment["status"]
    decision = {"assessmentId": request.assessment_id, "action": request.action, "changed": response["changed"],
                "fromVersion": before["version"], "version": state["standing"]["version"],
                "statement": state["standing"]["statement"], "time": stamp}
    state["decisions"].append(decision)
    state["history"].append({"type": "decision", **{key: value for key, value in decision.items() if key != "statement"}})
    if response["changed"]:
        state["versions"].append({"standing": deepcopy(state["standing"]), "time": stamp})
    state["pendingId"], state["updatedAt"] = None, stamp
    validate_state(state)
    kind = {"accept": "decision_accepted", "edit": "decision_edited", "reject": "decision_rejected",
            "keep_unresolved": "decision_kept_unresolved"}[request.action]
    events = [_event(kind, decision=deepcopy(decision))]
    if response["changed"]:
        events.append(_event("thesis_revised", from_version=before["version"],
                             standing=deepcopy(state["standing"]), assessment_id=request.assessment_id))
    return state, events


def adopt_baseline(request, workspace_id, now=None):
    """A new workspace whose Standing v1 is the server's own projection of the approved baseline."""
    stamp = _stamp(now)
    standing = baseline_lineage.adoption_standing(request.language)
    lineage = baseline_lineage.new_lineage(request.language, stamp)
    state = {"id": workspace_id, "mode": "custom", "standing": standing, "authored": standing["statement"],
             "language": request.language, "createdAt": stamp, "updatedAt": stamp,
             "versions": [{"standing": deepcopy(standing), "time": stamp}], "evidence": [],
             "assessments": [], "decisions": [], "pendingId": None,
             "history": [{"type": "created", "version": 1, "time": stamp}], "lineage": lineage}
    validate_state(state)
    return state, [_event("workspace_created", standing=deepcopy(standing), authored=standing["statement"],
                          language=request.language),
                   _event("baseline_adopted", lineage=deepcopy(lineage))]


def archive_workspace(workspace, request, now=None):
    current = validate_concurrency(workspace, request)
    state = current["current_state"]
    state["updatedAt"] = _stamp(now)
    return state, [_event("workspace_archived", thesis_version=state["standing"]["version"])]


def import_workspace(request, workspace_id=None, now=None):
    if len(_json(request).encode("utf-8")) > 96000:
        raise service.ProductError("input_too_large", "This workspace is too large to import in one request.", 413)
    source = import_snapshot(request.workspace)
    # Baseline lineage and acquired filings exist only when the server created them; a browser
    # import can never claim them.
    if any(key in source for key in ("lineage", "checks")) or \
            any(isinstance(item, dict) and "acquisition" in item for item in source.get("evidence") or []) or \
            any(isinstance(item, dict) and "check" in item for item in source.get("assessments") or []):
        _bad("This workspace carries server-only check records and cannot be imported.")
    state = validate_state(source)
    source_id, digest = state["id"], content_digest(source)
    state["id"] = workspace_id or str(uuid.uuid4())
    for record in state["assessments"]:
        record["imported"] = True
        record["importedOriginalStatus"] = record["status"]
        evidence = next(item for item in state["evidence"] if item["id"] == record["evidenceId"])
        record["evidenceDigest"] = content_digest(evidence["content"])
        if record["status"] == "pending":
            record["status"], evidence["status"] = "superseded", "superseded"
    for record in state["evidence"]:
        if record["status"] == "pending" and record["assessmentId"] is None:
            record["status"] = "failed"
    state["pendingId"] = None
    # Retain investment/history timestamps; the DB wrapper records import time.
    validate_state(state)
    return state, [_event("session_imported", source_workspace_id=source_id, source_digest=digest,
                          imported_at=_stamp(now), prior_history_unverified=True,
                          pending_assessment_requires_reassessment=source["pendingId"] is not None,
                          versions=len(state["versions"]), evidence=len(state["evidence"]),
                          assessments=len(state["assessments"]), decisions=len(state["decisions"]))]
