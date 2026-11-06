"""Deterministic persistence-domain checks; no database/network or real credentials."""
import asyncio
from copy import deepcopy
import time

import pytest
from pydantic import ValidationError

from hosted import durable_service as domain, service
from hosted.durable_models import (ArchiveWorkspaceRequest, AssessWorkspaceRequest,
    CreateWorkspaceRequest, DecideWorkspaceRequest, ImportWorkspaceRequest, WorkspaceRecord)
from hosted.models import Assessment, Standing


STAMP = "2026-10-06T04:00:00.000Z"


def standing():
    return {"ticker": "TEST", "version": 1,
            "statement": "Growth depends on durable demand and timely execution.",
            "drivers": [{"driver_id": f"D{i}", "title": label, "statement": label + " must remain durable.",
                         "falsifiers": [label + " deteriorates."], "what_to_watch": "Comparable " + label.lower() + "."}
                        for i, label in enumerate(["Demand", "Execution", "Margins"], 1)],
            "falsifiers": ["Demand contracts over multiple periods."]}


def evidence():
    return {"event_date": "2026-10-06", "information": "Timetable changed", "source": "Synthetic source",
            "source_text": "  The timetable moved from September to December.\n"}


def assessment():
    return {"relevant": True, "relation": "contradict", "reasoning": "The timetable contradicts the execution assumption.",
            "driver_impacts": [{"driver_id": "D2", "relation": "contradict",
                                "reasoning": "The previously assumed date changed.",
                                "exact_quote": "The timetable moved from September to December."}],
            "what_changed": ["The timetable is later than assumed."],
            "proposed_change": {"action": "revise", "revised_statement": "Growth depends on demand, with later execution timing.",
                                "reason": "The execution assumption changed."}, "what_to_watch": ["Next timetable update."]}


def wrapper(state, revision=1):
    return {"id": state["id"], "revision": revision, "active_thesis_version": state["standing"]["version"],
            "current_state": state, "created_at": STAMP, "updated_at": STAMP, "archived_at": None}


def create_request(**updates):
    return CreateWorkspaceRequest(standing=standing(), authored="  Original human thesis text.\n",
                                  language="en", idempotency_key="create-1", **updates)


def workspace():
    state, _ = domain.create_workspace(create_request(), workspace_id="workspace-1", now=STAMP)
    return wrapper(state)


@pytest.fixture(autouse=True)
def no_network_model(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "deterministic-domain-fixture")
    async def model(prompt, context, schema):
        return schema.model_validate(assessment())
    monkeypatch.setattr(service, "model_json", model)


def assessed(current=None, language="en"):
    current = current or workspace()
    request = AssessWorkspaceRequest(evidence=evidence(), language=language, expected_revision=current["revision"],
        expected_thesis_version=current["active_thesis_version"], idempotency_key="assess-1")
    state, events = asyncio.run(domain.assess_workspace(current, request, now=STAMP))
    return wrapper(state, current["revision"] + 1), events


def decision(current, action="accept", **updates):
    return DecideWorkspaceRequest(assessment_id=current["current_state"]["pendingId"], action=action,
        expected_revision=current["revision"], expected_thesis_version=current["active_thesis_version"],
        idempotency_key="decision-1", **updates)


def assert_domain_error(call, code="invalid_workspace", status=422):
    with pytest.raises(service.ProductError) as caught:
        call()
    assert caught.value.code == code
    assert caught.value.status == status


def test_confirmed_create_retains_original_authored_text_and_starts_v1():
    state, events = domain.create_workspace(create_request(), workspace_id="workspace-1", now=STAMP)
    assert state["authored"] == "  Original human thesis text.\n"
    assert state["standing"] == standing()
    assert len(state["versions"]) == 1 and state["pendingId"] is None
    assert [event["event_type"] for event in events] == ["workspace_created"]
    assert not {"draft", "action", "error"} & state.keys()


@pytest.mark.parametrize("field,value", [("version", 2), ("version", 10001)])
def test_create_cannot_claim_arbitrary_version(field, value):
    with pytest.raises(ValidationError):
        CreateWorkspaceRequest(standing={**standing(), field: value}, authored="Human thesis statement.", idempotency_key="create-1")


@pytest.mark.parametrize("field,value", [("expected_revision", True), ("expected_revision", "1"),
    ("expected_thesis_version", 0), ("idempotency_key", "x" * 129)])
def test_strict_mutation_request_contract(field, value):
    data = {"expected_revision": 1, "expected_thesis_version": 1, "idempotency_key": "archive-1", field: value}
    with pytest.raises(ValidationError):
        ArchiveWorkspaceRequest(**data)


def test_assessment_is_bound_to_source_and_standing_without_mutation():
    original = workspace()
    output, events = assessed(original, language="zh")
    state = output["current_state"]
    assert original["current_state"]["assessments"] == []
    assert state["standing"] == standing() and len(state["versions"]) == 1
    assert state["evidence"][0]["content"]["source_text"] == evidence()["source_text"]
    assert state["assessments"][0]["baseStanding"] == standing()
    assert state["assessments"][0]["language"] == "zh"
    assert state["assessments"][0]["evidenceDigest"] == domain.content_digest(state["evidence"][0]["content"])
    assert [event["event_type"] for event in events] == ["evidence_added", "assessment_created"]


@pytest.mark.parametrize("action,changed", [("accept", True), ("edit", True), ("reject", False), ("keep_unresolved", False)])
def test_human_decisions_preserve_text_only_versioning(action, changed):
    current, _ = assessed()
    updates = {"edited_statement": "My own revision describes the later execution timetable."} if action == "edit" else {}
    state, events = domain.decide_workspace(current, decision(current, action, **updates), now=STAMP)
    assert current["current_state"]["pendingId"] is not None
    assert state["standing"]["version"] == 1 + int(changed)
    assert len(state["versions"]) == 1 + int(changed)
    assert state["standing"]["drivers"] == standing()["drivers"]
    assert state["pendingId"] is None and state["decisions"][0]["changed"] == changed
    assert ("thesis_revised" in [event["event_type"] for event in events]) == changed


def test_unchanged_edit_records_decision_without_fake_version():
    current, _ = assessed()
    state, events = domain.decide_workspace(current, decision(current, "edit", edited_statement=standing()["statement"]), now=STAMP)
    assert state["standing"] == standing() and len(state["versions"]) == 1
    assert len(events) == 1 and not state["decisions"][0]["changed"]


def test_decided_assessment_cannot_be_applied_twice_without_repository_retry():
    current, _ = assessed()
    request = decision(current)
    state, _ = domain.decide_workspace(current, request, now=STAMP)
    retry = request.model_copy(update={"expected_revision": 3, "expected_thesis_version": 2})
    assert_domain_error(lambda: domain.decide_workspace(wrapper(state, 3), retry), "stale_assessment", 409)


def test_next_assessment_supersedes_pending_and_preserves_prior_evidence():
    current, _ = assessed()
    next_current, _ = assessed(current)
    state = next_current["current_state"]
    assert len(state["evidence"]) == 2 and len(state["assessments"]) == 2
    assert state["assessments"][0]["status"] == "superseded"
    assert state["evidence"][0]["status"] == "superseded"
    assert state["pendingId"] == state["assessments"][1]["id"]


@pytest.mark.parametrize("field", ["expected_revision", "expected_thesis_version"])
def test_stale_concurrency_rejected_before_model_call(monkeypatch, field):
    async def forbidden(*args):
        pytest.fail("A stale mutation called the model")
    monkeypatch.setattr(service, "assess", forbidden)
    data = {"evidence": evidence(), "expected_revision": 1, "expected_thesis_version": 1,
            "idempotency_key": "assess-1", field: 2}
    assert_domain_error(lambda: asyncio.run(domain.assess_workspace(workspace(), AssessWorkspaceRequest(**data))), "stale_workspace", 409)


def test_archived_workspace_cannot_mutate():
    current = workspace()
    current["archived_at"] = STAMP
    request = ArchiveWorkspaceRequest(expected_revision=1, expected_thesis_version=1, idempotency_key="archive-1")
    assert_domain_error(lambda: domain.archive_workspace(current, request), "workspace_archived", 409)


def test_archive_keeps_standing_and_audits_explicit_action():
    current = workspace()
    state, events = domain.archive_workspace(current, ArchiveWorkspaceRequest(
        expected_revision=1, expected_thesis_version=1, idempotency_key="archive-1"), now=STAMP)
    assert state["standing"] == standing() and len(state["versions"]) == 1
    assert events[0]["event_type"] == "workspace_archived"


def test_expired_receipt_fails_closed_without_state_changes():
    current, _ = assessed()
    record = current["current_state"]["assessments"][0]
    stamp = int(time.time()) - 86401
    record["receipt"] = f"{stamp}.{service.signature(Standing.model_validate(standing()), Assessment.model_validate(assessment()), stamp)}"
    before = deepcopy(current)
    assert_domain_error(lambda: domain.decide_workspace(current, decision(current)), "stale_assessment", 409)
    assert current == before


def test_import_preserves_artifacts_and_retires_pending_receipt():
    current, _ = assessed()
    local = deepcopy(current["current_state"])
    local.update(action="review", draft={"decision": "accept"}, error="")
    request = ImportWorkspaceRequest(workspace=local, idempotency_key="import-1")
    state, events = domain.import_workspace(request, workspace_id="cloud-1", now=STAMP)
    assert request.workspace == local
    assert state["id"] == "cloud-1" and state["pendingId"] is None
    assert state["history"] == local["history"] and state["versions"] == local["versions"]
    assert state["assessments"][0]["receipt"] == local["assessments"][0]["receipt"]
    assert state["assessments"][0]["payload"] == local["assessments"][0]["payload"]
    assert state["assessments"][0]["importedOriginalStatus"] == "pending"
    assert state["assessments"][0]["status"] == "superseded"
    assert events[0]["payload"]["source_workspace_id"] == local["id"]
    assert events[0]["payload"]["source_digest"] == domain.import_digest(local)
    assert events[0]["payload"]["pending_assessment_requires_reassessment"]


@pytest.mark.parametrize("action", ["accept", "edit", "reject", "keep_unresolved"])
def test_import_preserves_decided_version_history(action):
    current, _ = assessed()
    updates = {"edited_statement": "My own revision describes the later execution timetable."} if action == "edit" else {}
    local, _ = domain.decide_workspace(current, decision(current, action, **updates), now=STAMP)
    imported, _ = domain.import_workspace(ImportWorkspaceRequest(workspace=local, idempotency_key="import-1"), now=STAMP)
    assert imported["standing"] == local["standing"]
    assert imported["versions"] == local["versions"] and imported["decisions"] == local["decisions"]


@pytest.mark.parametrize("tamper", ["quote", "driver", "duplicate_evidence", "evidence_link", "assessment_link",
    "pending_status", "base_standing", "other_snapshot_field", "version_gap", "current_snapshot", "unknown_field",
    "demo", "coercion", "fake_history", "source_authority"])
def test_import_adversarial_graph_and_history_rejected_without_mutation(tamper):
    current, _ = assessed()
    local = deepcopy(current["current_state"])
    if tamper == "quote": local["assessments"][0]["payload"]["driver_impacts"][0]["exact_quote"] = "Invented source quotation."
    if tamper == "driver": local["assessments"][0]["payload"]["driver_impacts"][0]["driver_id"] = "foreign-driver"
    if tamper == "duplicate_evidence": local["evidence"].append(deepcopy(local["evidence"][0]))
    if tamper == "evidence_link": local["assessments"][0]["evidenceId"] = "foreign-evidence"
    if tamper == "assessment_link": local["evidence"][0]["assessmentId"] = "foreign-assessment"
    if tamper == "pending_status": local["pendingId"] = None
    if tamper == "base_standing": local["assessments"][0]["baseStanding"]["statement"] = "An unrelated standing thesis statement."
    if tamper in {"other_snapshot_field", "version_gap"}:
        s = deepcopy(local["standing"])
        s["statement"], s["version"] = "An unrelated revised thesis statement.", 2 if tamper == "other_snapshot_field" else 3
        if tamper == "other_snapshot_field": s["drivers"][0]["title"] = "Mutated driver title"
        local["versions"].append({"standing": s, "time": STAMP})
        local["standing"] = deepcopy(s)
    if tamper == "current_snapshot": local["standing"]["statement"] = "An unrelated standing thesis statement."
    if tamper == "unknown_field": local["secret_override"] = True
    if tamper == "demo": local["mode"] = "demo"
    if tamper == "coercion": local["standing"]["version"] = "1"
    if tamper == "fake_history": local["history"][1]["version"] = 2
    if tamper == "source_authority": local["evidence"][0]["sourceVerified"] = True
    before = deepcopy(local)
    assert_domain_error(lambda: domain.import_workspace(ImportWorkspaceRequest(workspace=local, idempotency_key="import-1")))
    assert local == before


def test_import_over_bound_raises_413():
    local = workspace()["current_state"]
    local["draft"] = {"recoverable": "x" * 96000}
    assert_domain_error(lambda: domain.import_workspace(ImportWorkspaceRequest(workspace=local, idempotency_key="import-1")), "input_too_large", 413)


def test_digest_ignores_retry_key_and_transient_import_ui_only():
    local = workspace()["current_state"]
    first = ImportWorkspaceRequest(workspace=local, idempotency_key="import-1")
    other = ImportWorkspaceRequest(workspace={**local, "draft": {"statement": "transient"}}, idempotency_key="import-2")
    assert domain.request_digest(first, "import") == domain.request_digest(other, "import")
    assert domain.import_digest(first.workspace) == domain.import_digest(other.workspace)
    other.workspace["authored"] += " A real artifact change."
    assert domain.import_digest(first.workspace) != domain.import_digest(other.workspace)


def test_workspace_model_roundtrip_can_validate_existing_source_digest():
    current, _ = assessed()
    parsed = WorkspaceRecord.model_validate(current)
    request = decision(current, "reject")
    state, _ = domain.decide_workspace(parsed, request, now=STAMP)
    assert state["standing"]["version"] == 1


def test_import_recovered_legacy_v061_history_without_inventing_snapshots():
    current, _ = assessed()
    local, _ = domain.decide_workspace(current, decision(current), now=STAMP)
    local["createdAt"], local["updatedAt"] = None, None
    for group in ("versions", "evidence", "assessments", "decisions"):
        for record in local[group]:
            record["time"] = None
    local["decisions"][0]["assessmentId"] = None
    del local["decisions"][0]["statement"]
    local["history"] = [{"type": "legacy", "time": None,
                        "records": [{"decision": "accept", "changed": True, "version": 2,
                                     "title": "  Original historical evidence summary.\n",
                                     "source": "  Original historical source label.\n"}]}]
    imported, events = domain.import_workspace(ImportWorkspaceRequest(workspace=local, idempotency_key="import-legacy"), now=STAMP)
    assert imported["createdAt"] is None
    assert imported["history"] == local["history"] and imported["versions"] == local["versions"]
    assert events[0]["payload"]["prior_history_unverified"]


@pytest.mark.parametrize("field,length", [("title", 10001), ("source", 1001)])
def test_import_legacy_history_labels_remain_bounded(field, length):
    local = workspace()["current_state"]
    local["history"] = [{"type": "legacy", "time": None, "records": [{
        "decision": "reject", "changed": False, "version": 1, field: "x" * length}]}]
    local["decisions"] = [{"assessmentId": None, "action": "reject", "changed": False,
                           "fromVersion": 1, "version": 1, "time": None}]
    assert_domain_error(lambda: domain.import_workspace(ImportWorkspaceRequest(workspace=local, idempotency_key="legacy-bounds")))


@pytest.mark.parametrize("missing", ["decisions", "history_records"])
def test_import_legacy_history_and_decisions_must_project_in_both_directions(missing):
    local = workspace()["current_state"]
    records = [{"decision": "accept", "changed": True, "version": 9999,
                "title": "Invented historical revision", "source": "Unverified imported history"}]
    decisions = [{"assessmentId": None, "action": "accept", "changed": True,
                  "fromVersion": 9998, "version": 9999, "time": None}]
    local["history"] = [{"type": "legacy", "time": None,
                        "records": records if missing == "decisions" else []}]
    local["decisions"] = decisions if missing == "history_records" else []
    before = deepcopy(local)
    assert_domain_error(lambda: domain.import_workspace(ImportWorkspaceRequest(workspace=local, idempotency_key="legacy-projection")))
    assert local == before


def test_import_legacy_workspace_without_available_decision_history_remains_supported():
    local = workspace()["current_state"]
    local["history"] = [{"type": "legacy", "time": None, "records": []}]
    local["createdAt"], local["updatedAt"], local["versions"][0]["time"] = None, None, None
    imported, _ = domain.import_workspace(ImportWorkspaceRequest(workspace=local, idempotency_key="legacy-empty"), now=STAMP)
    assert imported["history"] == local["history"]
    assert imported["decisions"] == [] and imported["standing"] == local["standing"]


def legacy_partial_history(versions):
    local = workspace()["current_state"]
    baseline = {**standing(), "version": 8}
    latest = {**baseline, "version": 9, "statement": "A later human-approved thesis retains durable demand."}
    local["standing"] = deepcopy(latest)
    local["versions"] = [{"standing": baseline, "time": None}, {"standing": deepcopy(latest), "time": None}]
    local["createdAt"], local["updatedAt"] = None, None
    local["history"] = [{"type": "legacy", "time": None, "records": [
        {"decision": "accept", "changed": True, "version": version,
         "title": "Original older observation", "source": "Original older source"} for version in versions]}]
    local["decisions"] = [{"assessmentId": None, "action": "accept", "changed": True,
                           "fromVersion": version - 1, "version": version, "time": None} for version in versions]
    return local


@pytest.mark.parametrize("versions", [[8, 2, 9], [8, 8, 9], [8, 10, 9]])
def test_import_legacy_partial_history_cannot_move_backwards_repeat_or_skip_versions(versions):
    local = legacy_partial_history(versions)
    assert_domain_error(lambda: domain.import_workspace(ImportWorkspaceRequest(workspace=local, idempotency_key="legacy-chain")))


def test_import_legacy_partial_history_chains_without_inventing_missing_baseline():
    local = legacy_partial_history([8, 9])
    imported, _ = domain.import_workspace(ImportWorkspaceRequest(workspace=local, idempotency_key="legacy-partial"), now=STAMP)
    assert imported["versions"] == local["versions"]
    assert imported["history"] == local["history"] and imported["decisions"] == local["decisions"]
    assert [snapshot["standing"]["version"] for snapshot in imported["versions"]] == [8, 9]


def test_import_cannot_decide_superseded_assessment_even_without_text_change():
    current, _ = assessed()
    second, _ = assessed(current)
    local = second["current_state"]
    old = local["assessments"][0]
    old["status"] = "decided"
    local["evidence"][0]["status"] = "decided"
    record = {"assessmentId": old["id"], "action": "reject", "changed": False,
              "fromVersion": 1, "version": 1, "statement": standing()["statement"], "time": STAMP}
    local["decisions"].append(record)
    local["history"].append({"type": "decision", **{key: value for key, value in record.items() if key != "statement"}})
    assert_domain_error(lambda: domain.import_workspace(ImportWorkspaceRequest(workspace=local, idempotency_key="import-stale")))


def test_model_failure_preserves_authoritative_state(monkeypatch):
    current = workspace()
    before = deepcopy(current)
    async def failed(*args):
        raise service.ProductError("model_timeout", "Research took too long.", 504)
    monkeypatch.setattr(service, "assess", failed)
    request = AssessWorkspaceRequest(evidence=evidence(), expected_revision=1,
        expected_thesis_version=1, idempotency_key="assess-timeout")
    assert_domain_error(lambda: asyncio.run(domain.assess_workspace(current, request)), "model_timeout", 504)
    assert current == before
