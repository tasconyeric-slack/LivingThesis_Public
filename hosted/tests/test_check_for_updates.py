"""Authenticated NVIDIA Check for Updates through the real API, domain rules and check core.

SEC responses and model outputs are SYNTHETIC fixtures (hosted/tests/check_fixture.py); storage is the
transactional in-memory fixture that mirrors the database's owner scope, CAS and idempotency.
"""
import json
from copy import deepcopy

import pytest
from fastapi.testclient import TestClient

from api.index import app
from backend.src.living_thesis import evidence_check as ec
from hosted import baseline_lineage, check_service, durable_api, service
from hosted.models import Assessment
from hosted.tests import check_fixture as cf
from hosted.tests.durable_fixture import MemoryRepository
from hosted.tests.test_hosted_api import assessment, evidence, standing

_real_runtime = check_service.runtime   # captured before any test replaces it
AUTH_A = {"Authorization": "Bearer fixture-user-a"}
AUTH_B = {"Authorization": "Bearer fixture-user-b"}
fx = cf.fx


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-check-receipt-key")
    repo = MemoryRepository()
    holder = {"rt": cf.runtime()}

    async def fixture_repository():
        yield repo

    async def model_json(*args):
        return Assessment.model_validate(assessment())

    monkeypatch.setattr(service, "model_json", model_json)
    monkeypatch.setattr(check_service, "runtime", lambda: holder["rt"])
    app.dependency_overrides[durable_api.repository] = fixture_repository
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client, repo, holder
    app.dependency_overrides.clear()


def adopt(client, language="en", key="adopt-1", headers=AUTH_A):
    response = client.post("/api/workspaces/adopt-baseline", headers=headers, json={"language": language, "idempotency_key": key})
    assert response.status_code == 200, response.text
    return response.json()


def concurrency(row, key):
    return {"expected_revision": row["revision"], "expected_thesis_version": row["active_thesis_version"], "idempotency_key": key}


def step(client, row, key, headers=AUTH_A):
    return client.post(f"/api/workspaces/{row['id']}/check", headers=headers, json=concurrency(row, key))


def check(client, row, prefix="c"):
    """Click Check for Updates: repeat bounded steps until no run is active, as the browser does."""
    for index in range(40):
        response = step(client, row, f"{prefix}-{index}")
        assert response.status_code == 200, response.text
        row = response.json()
        if row["current_state"]["checks"]["active"] is None:
            return row, index + 1
    raise AssertionError("check did not finish")


def decide(client, row, action, key, **extra):
    body = {"assessment_id": row["current_state"]["pendingId"], "action": action, **concurrency(row, key), **extra}
    return client.post(f"/api/workspaces/{row['id']}/decision", headers=AUTH_A, json=body)


def last_run(row):
    return row["current_state"]["checks"]["runs"][-1]


# ---------------------------------------------------------------- lineage and eligibility

@pytest.mark.parametrize("language", ["en", "zh"])
def test_adoption_is_built_by_the_server_and_retries_are_idempotent(env, language):
    client, repo, _ = env
    row = adopt(client, language)
    state = row["current_state"]
    assert state["standing"] == baseline_lineage.adoption_standing(language)
    lineage = state["lineage"]
    assert lineage["baseline_content_sha256"] == ec.APPROVED_CONTENT_SHA256 == baseline_lineage.APPROVED_CONTENT_SHA256
    assert lineage["check_standing_sha256"] == ec.standing_sha256(ec.load_standing())
    assert lineage["monitoring"] == [{"version": 1, "statement_sha256": baseline_lineage.digest(state["standing"]["statement"]),
                                      "basis": "adoption", "time": lineage["adopted_at"]}]
    assert [e["event_type"] for e in repo.events[row["id"]]] == ["workspace_created", "baseline_adopted"]
    assert adopt(client, language) == row                     # lost response, same key
    assert len(repo.rows) == 1
    assert client.post("/api/workspaces/adopt-baseline", headers=AUTH_A,
                       json={"language": language, "idempotency_key": "adopt-2"}).json()["error"]["code"] == "duplicate_ticker"


def test_adoption_takes_no_thesis_text_from_the_browser(env):
    client, _, _ = env
    body = {"language": "en", "idempotency_key": "forged", "standing": standing()}
    assert client.post("/api/workspaces/adopt-baseline", headers=AUTH_A, json=body).status_code == 422
    assert client.post("/api/workspaces/adopt-baseline", json={"language": "en", "idempotency_key": "x"}).status_code == 401


def test_baseline_projection_matches_the_shipped_check_standing():
    projection = json.loads(baseline_lineage.PROJECTION.read_text(encoding="utf-8"))
    assert projection["baseline_content_sha256"] == ec.APPROVED_CONTENT_SHA256
    assert baseline_lineage.adoption_standing("en") == ec.load_standing()["hosted_standing"]
    assert projection["evidence_through"] == ec.load_standing()["evidence_through"]
    for language in ("en", "zh"):
        assert len(baseline_lineage.adoption_standing(language)["falsifiers"]) == 8


def test_identical_text_without_server_lineage_is_not_eligible(env):
    """An NVDA thesis typed or pasted in the browser is never treated as the approved baseline."""
    client, _, _ = env
    copy = baseline_lineage.adoption_standing("en")
    row = client.post("/api/workspaces", headers=AUTH_A, json={"standing": copy, "authored": copy["statement"],
                                                               "language": "en", "idempotency_key": "typed"}).json()
    response = step(client, row, "attempt")
    assert response.status_code == 409 and response.json()["error"]["code"] == "check_not_eligible"
    other = client.post("/api/workspaces", headers=AUTH_B, json={"standing": standing(), "authored": standing()["statement"],
                                                                 "language": "en", "idempotency_key": "msft"}).json()
    assert step(client, other, "attempt", AUTH_B).json()["error"]["code"] == "check_not_eligible"


def test_imports_can_never_claim_lineage_or_check_records(env):
    client, _, _ = env
    adopted = adopt(client)["current_state"]
    for forged in ({**adopted}, {**adopted, "lineage": None, "checks": {"schema_version": "workspace-checks-0.1",
                                                                         "checkpoint": {}, "runs": []}}):
        response = client.post("/api/workspaces/import", headers=AUTH_B, json={"workspace": forged, "idempotency_key": "imp"})
        assert response.status_code == 422, response.text


def test_tampered_lineage_fails_state_validation(env):
    client, _, _ = env
    state = adopt(client)["current_state"]
    from hosted import durable_service
    for mutate in (lambda s: s["versions"][0]["standing"].update(statement="A different statement entirely."),
                   lambda s: s["lineage"].update(baseline_content_sha256="0" * 64),
                   lambda s: s["lineage"]["monitoring"].append({"version": 1, "statement_sha256": "0" * 64,
                                                                "basis": "investor_confirmed", "time": None})):
        bad = deepcopy(state)
        mutate(bad)
        with pytest.raises(service.ProductError):
            durable_service.validate_state(bad)


# ---------------------------------------------------------------- the check, end to end

def test_check_runs_the_cascade_and_hands_a_validated_proposal_to_the_human(env):
    client, repo, holder = env
    holder["rt"] = cf.runtime(transport=cf.Transport(assessment=cf.REVISE))
    row = adopt(client)
    row, requests = check(client, row)
    state = row["current_state"]
    run = last_run(row)
    assert run["outcome"] == "assessment_needs_review"
    # start (EDGAR + Stage 0) + N-PX triage + 8-K triage + 8-K assessment
    assert requests == 4
    assert run["funnel"]["stage0_filtered"] == 3 and run["funnel"]["irrelevant"] == 1
    assert run["funnel"]["watch_item_evidence"] == 1 and run["funnel"]["assessments"] == 1
    assert run["totals"]["model_calls"] == 3 and run["totals"]["deep_research_calls"] == 1
    npx = next(e for e in run["events"] if e["accession"] == fx.NPX)
    assert npx["outcome"] == "irrelevant_stopped" and npx["deep_research_calls"] == 0
    # The Standing is untouched until an explicit human decision.
    assert state["standing"] == baseline_lineage.adoption_standing("en") and row["active_thesis_version"] == 1
    pending = next(a for a in state["assessments"] if a["id"] == state["pendingId"])
    record = next(e for e in state["evidence"] if e["id"] == pending["evidenceId"])
    assert pending["check"]["run_id"] == run["run_id"] and record["acquisition"]["accession"] == fx.EVENT_8K
    assert record["acquisition"]["sources"][0]["url"].startswith("https://www.sec.gov/Archives/edgar/data/1045810/")
    assert all(i["exact_quote"] in record["content"]["source_text"] for i in pending["payload"]["driver_impacts"])
    assert pending["check"]["scope"]["affected_watch_item_ids"] == ["W3.1", "W5.1"]
    assert pending["check"]["semantic_entailment_checked"] is False
    # Checkpoint advanced only because every filing reached an outcome.
    assert run["reviewed_through_after"] == run["as_of"] == "2026-10-19T00:00:00Z"
    assert set(state["checks"]["checkpoint"]["processed"]) == {f"edgar:{fx.NPX}", f"edgar:{fx.EVENT_8K}"}
    accepted = decide(client, row, "accept", "accept-1")
    assert accepted.status_code == 200, accepted.text
    after = accepted.json()
    assert after["active_thesis_version"] == 2
    assert after["current_state"]["standing"]["statement"] == cf.REVISE["proposed_change"]["revised_statement"]
    assert after["current_state"]["standing"]["drivers"] == state["standing"]["drivers"]


def test_rechecking_the_same_filings_costs_nothing_and_duplicates_nothing(env):
    client, repo, holder = env
    row, _ = check(client, adopt(client))
    calls = len(holder["rt"].transport.calls)
    sec = holder["rt"].sec
    before = len(sec.requests)
    decided = decide(client, row, "keep_unresolved", "keep-1").json()
    # A fresh process: nothing carried in memory except the database row.
    holder["rt"] = cf.runtime(sec=sec)
    again, requests = check(client, decided, "again")
    run = last_run(again)
    assert requests == 1 and holder["rt"].transport.calls == [] and calls == 3
    assert sec.requests[before:] == ["submissions"]          # no filing fetched again
    assert run["outcome"] == "no_new_material_evidence" and run["totals"]["model_calls"] == 0
    assert run["funnel"]["stage0_filtered_by_reason"]["duplicate_already_processed"] == 2 and run["events"] == []
    assert len(again["current_state"]["assessments"]) == 1
    assert run["reaffirmation"]["reviewed_through"] == run["as_of"]


def test_driver_context_and_irrelevant_filings_spawn_no_deep_research(env):
    client, _, holder = env
    context = {"classification": "driver_context", "watch_item_answers": [], "uncertain_watch_item_ids": [],
               "driver_context": [{"driver_id": "D3", "note": "An acquisition is ecosystem context, not adoption loss.",
                                   "exact_quote": "FixtureCo commits to keep the platform open and to support other silicon vendors."}],
               "rationale": "No approved Watch Item question is answered."}
    holder["rt"] = cf.runtime(transport=cf.Transport(triage={**fx.TRIAGE, fx.EVENT_8K: context}))
    row, _ = check(client, adopt(client))
    run = last_run(row)
    assert run["outcome"] == "driver_context_only" and run["totals"]["deep_research_calls"] == 0
    assert row["current_state"]["pendingId"] is None and row["current_state"]["assessments"] == []
    assert [c["stage"] for c in holder["rt"].transport.calls] == ["triage", "triage"]


def test_the_china_origin_leak_is_demoted_by_code_without_research(env):
    client, _, holder = env
    holder["rt"] = cf.runtime(transport=cf.Transport(triage={**fx.TRIAGE, fx.EVENT_8K: fx.LEAKY_TRIAGE}))
    row, _ = check(client, adopt(client))
    event = next(e for e in last_run(row)["events"] if e["accession"] == fx.EVENT_8K)
    assert event["result"] == "driver_context" and event["deep_research_calls"] == 0


# ---------------------------------------------------------------- ownership and authorization

def test_only_the_owner_can_check_or_read_runs(env):
    client, _, _ = env
    row = adopt(client)
    assert step(client, row, "anon", headers={}).status_code == 401
    assert step(client, row, "forged", headers={"Authorization": "Bearer forged"}).status_code == 401
    assert step(client, row, "b", headers=AUTH_B).status_code == 404
    done, _ = check(client, row)
    run_id = last_run(done)["run_id"]
    path = f"/api/workspaces/{row['id']}/checks/{run_id}"
    assert client.get(path, headers=AUTH_B).status_code == 404
    assert client.get(path).status_code == 401
    assert client.get(f"/api/workspaces/{row['id']}/checks/../../x", headers=AUTH_A).status_code in (404, 422)


def test_run_record_is_inspectable_and_verified(env):
    client, _, _ = env
    done, _ = check(client, adopt(client))
    run = last_run(done)
    record = client.get(f"/api/workspaces/{done['id']}/checks/{run['run_id']}", headers=AUTH_A).json()
    assert record["integrity"] == {"parts": 4, "complete": True, "part_digests_match": True, "record_sha256_matches": True}
    assert record["record_sha256"] == run["record_sha256"] and record["fixture"] is False
    assert {c["stage"] for c in record["model_calls"]} == {"triage", "assess"}
    assert all(c["prompt_sha256"] and c["context_sha256"] and c["raw_output_sha256"] for c in record["model_calls"])
    assert record["started"]["prompts"]["triage"]["contract"] == "triage-context-0.2"
    assert record["started"]["environment"]["sec_user_agent"] == "configured (contact redacted)"
    eight_k = next(e for e in record["events"] if e["accession"] == fx.EVENT_8K)
    assert eight_k["sources"][0]["sha256"] and eight_k["timestamps"]["header_acceptance_utc"] == "2026-09-03T12:03:56Z"
    assert eight_k["research"]["executed"] is True and record["funnel"]["proposals"] == 0
    assert "test-check-receipt-key" not in json.dumps(record)


# ---------------------------------------------------------------- versions and monitoring rules

def test_a_revised_thesis_requires_reconfirming_the_monitoring_rules(env, monkeypatch):
    client, repo, holder = env
    holder["rt"] = cf.runtime(transport=cf.Transport(assessment=cf.REVISE))
    row, _ = check(client, adopt(client))
    v2 = decide(client, row, "edit", "edit-1", edited_statement="My own revision keeps every driver but weights market access more.").json()
    assert v2["active_thesis_version"] == 2
    blocked = step(client, v2, "blocked")
    assert blocked.status_code == 409 and blocked.json()["error"]["code"] == "monitoring_revalidation_required"
    confirmed = client.post(f"/api/workspaces/{v2['id']}/monitoring/confirm", headers=AUTH_A, json=concurrency(v2, "confirm-1"))
    assert confirmed.status_code == 200, confirmed.text
    confirmed = confirmed.json()
    assert confirmed["current_state"]["lineage"]["monitoring"][-1]["version"] == 2
    assert confirmed["active_thesis_version"] == 2 and confirmed["current_state"]["standing"] == v2["current_state"]["standing"]
    assert repo.events[v2["id"]][-1]["event_type"] == "monitoring_confirmed"
    # A new filing is now judged against the investor's v2 statement, with the approved Watch Items.
    new = "0001045810-26-900009"
    monkeypatch.setitem(fx.FILES, new, fx.FILES[fx.EVENT_8K])
    monkeypatch.setitem(fx.HEADERS, new, ("20261015160000", "8-K"))
    sec = fx.FakeSec()
    sec_sub = deepcopy(fx.SUBMISSIONS)
    for key, value in zip(["accessionNumber", "form", "filingDate", "reportDate", "primaryDocument", "items", "acceptanceDateTime"],
                          [new, "8-K", "2026-10-15", "2026-10-14", "fixture-8k.htm", "8.01", "2026-10-15T20:00:00.000Z"]):
        sec_sub["filings"]["recent"][key].append(value)
    sec.submissions = lambda cik: sec_sub
    holder["rt"] = cf.runtime(sec=sec, transport=cf.Transport(triage={**fx.TRIAGE, new: fx.TRIAGE[fx.NPX]}))
    done, _ = check(client, confirmed, "v2")
    seen = json.loads(holder["rt"].transport.calls[0]["user"])
    assert seen["standing"]["statement"] == v2["current_state"]["standing"]["statement"]
    assert [w["id"] for d in seen["standing"]["drivers"] for w in d["watch_items"]] == [
        "W1.1", "W1.2", "W1.3", "W1.4", "W2.1", "W2.2", "W3.1", "W3.2", "W3.3", "W3.4", "W4.1", "W5.1", "W5.2"]
    assert last_run(done)["standing_version"] == 2 and last_run(done)["outcome"] == "no_new_material_evidence"


def test_a_decision_during_a_run_stops_it_without_assessing_against_the_new_version(env):
    client, _, holder = env
    holder["rt"] = cf.runtime(transport=cf.Transport(assessment=cf.REVISE))
    row = adopt(client)
    started = step(client, row, "s0").json()                  # run started at v1, 2 filings queued
    manual = client.post(f"/api/workspaces/{row['id']}/assess", headers=AUTH_A, json={
        "evidence": evidence(), **concurrency(started, "manual-1")}).json()
    accepted = decide(client, manual, "accept", "manual-accept").json()
    assert accepted["active_thesis_version"] == 2
    # The open run never continues against v2: the next request closes it, with no fetch or model call.
    calls = len(holder["rt"].transport.calls)
    stopped = step(client, accepted, "s1")
    assert stopped.status_code == 200, stopped.text
    stopped = stopped.json()
    run = last_run(stopped)
    assert stopped["current_state"]["checks"]["active"] is None and run["stopped"] == "thesis_changed"
    assert run["outcome"] == "partial_failure" and run["reviewed_through_after"] is None
    assert run["funnel"]["not_reached"] == 2 and len(holder["rt"].transport.calls) == calls
    assert stopped["current_state"]["checks"]["checkpoint"]["processed"] == {}
    # Then the rules must be reconfirmed for v2 before another check.
    assert step(client, stopped, "s2").json()["error"]["code"] == "monitoring_revalidation_required"
    confirmed = client.post(f"/api/workspaces/{row['id']}/monitoring/confirm", headers=AUTH_A,
                            json=concurrency(stopped, "confirm"))
    assert confirmed.status_code == 200, confirmed.text
    done, _ = check(client, confirmed.json(), "v2")
    assert last_run(done)["standing_version"] == 2 and last_run(done)["outcome"] == "assessment_needs_review"


def test_confirming_closes_a_stale_run_in_the_same_transaction(env):
    client, repo, holder = env
    row = adopt(client)
    started = step(client, row, "s0").json()
    manual = client.post(f"/api/workspaces/{row['id']}/assess", headers=AUTH_A, json={
        "evidence": evidence(), **concurrency(started, "manual-1")}).json()
    accepted = decide(client, manual, "accept", "manual-accept").json()
    confirmed = client.post(f"/api/workspaces/{row['id']}/monitoring/confirm", headers=AUTH_A,
                            json=concurrency(accepted, "confirm")).json()
    assert confirmed["current_state"]["checks"]["active"] is None
    assert last_run(confirmed)["stopped"] == "thesis_changed"
    assert [e["event_type"] for e in repo.events[row["id"]][-2:]] == ["check_completed", "monitoring_confirmed"]


def test_stage2_waits_while_another_decision_is_pending(env):
    client, _, holder = env
    holder["rt"] = cf.runtime(transport=cf.Transport(assessment=cf.REVISE))
    row = adopt(client)
    row = client.post(f"/api/workspaces/{row['id']}/assess", headers=AUTH_A, json={
        "evidence": evidence(), **concurrency(row, "manual-1")}).json()
    pending_before = row["current_state"]["pendingId"]
    done, _ = check(client, row)
    run = last_run(done)
    held = next(e for e in run["events"] if e["accession"] == fx.EVENT_8K)
    assert held["outcome"] == "held_pending_decision" and held["deep_research_calls"] == 0
    assert run["outcome"] == "partial_failure" and run["reviewed_through_after"] is None
    assert f"edgar:{fx.EVENT_8K}" not in done["current_state"]["checks"]["checkpoint"]["processed"]
    assert done["current_state"]["pendingId"] == pending_before    # the manual assessment is not superseded
    decided = decide(client, done, "reject", "reject-1").json()
    later, _ = check(client, decided, "later")
    assert last_run(later)["outcome"] == "assessment_needs_review"


def test_pasted_evidence_cannot_supersede_a_pending_filing_assessment(env):
    client, _, _ = env
    row, _ = check(client, adopt(client))
    response = client.post(f"/api/workspaces/{row['id']}/assess", headers=AUTH_A, json={
        "evidence": evidence(), **concurrency(row, "manual")})
    assert response.status_code == 409 and response.json()["error"]["code"] == "check_assessment_pending"


def test_a_server_key_rotation_never_strands_a_filing_assessment(env, monkeypatch):
    """Review P1-1: check assessments are bound by their payload digest, not by a key-derived receipt."""
    client, _, _ = env
    row, _ = check(client, adopt(client))
    monkeypatch.setenv("DEEPSEEK_API_KEY", "rotated-server-key")
    assert decide(client, row, "reject", "after-rotation").status_code == 200


def test_tampered_check_payload_is_refused(env):
    client, repo, _ = env
    row, _ = check(client, adopt(client))
    from hosted import durable_service
    state = deepcopy(row["current_state"])
    state["assessments"][-1]["payload"]["reasoning"] = "Altered after validation."
    with pytest.raises(service.ProductError):
        durable_service.validate_state(state)


def test_workspace_state_stays_bounded_however_many_filings_are_filtered(env, monkeypatch):
    """Review P1-2: filtered filings are counted, not copied, into the workspace on every run."""
    client, _, holder = env
    sub = deepcopy(fx.SUBMISSIONS)
    for index in range(400):
        for key, value in zip(["accessionNumber", "form", "filingDate", "reportDate", "primaryDocument", "items",
                               "acceptanceDateTime"],
                              [f"0009999999-26-{index:06d}", "4", "2026-09-10", "", "f4.xml", "", "2026-09-10T20:00:00.000Z"]):
            sub["filings"]["recent"][key].append(value)
    sec = fx.FakeSec()
    sec.submissions = lambda cik: sub
    holder["rt"] = cf.runtime(sec=sec)
    row, _ = check(client, adopt(client))
    row = decide(client, row, "reject", "r").json()
    sizes = []
    for run in range(4):
        row, _ = check(client, row, f"again-{run}")
        sizes.append(len(json.dumps(row["current_state"])))
    assert last_run(row)["funnel"]["stage0_filtered"] >= 400
    assert max(b - a for a, b in zip(sizes, sizes[1:])) < 6000, sizes


def test_a_permanently_failing_filing_stops_costing_but_stays_unreviewed(env):
    """Review P1-3 + release closure: after the attempt limit a filing is not retried, and stays explicitly unreviewed."""
    client, _, holder = env
    holder["rt"] = cf.runtime(transport=cf.Transport(triage={**fx.TRIAGE, fx.NPX: {"classification": "nonsense"}}))
    row = adopt(client)
    for attempt in range(ec.MAX_FAILURE_ATTEMPTS):
        row, _ = check(client, row, f"try-{attempt}")
        if row["current_state"]["pendingId"]:
            row = decide(client, row, "keep_unresolved", f"keep-{attempt}").json()
    calls = len(holder["rt"].transport.calls)
    row, _ = check(client, row, "after-limit")
    run = last_run(row)
    assert len(holder["rt"].transport.calls) == calls          # no more model calls for it
    assert run["window"]["unreviewed_after_repeated_failure"][0]["accession"] == fx.NPX
    assert run["funnel"]["unreviewed_after_repeated_failure"] == 1
    # Bounded retries, but the exclusion is not a review: no clean conclusion, no coverage claim.
    assert run["outcome"] == "incomplete_coverage" and run["reaffirmation"] is None
    assert run["coverage"] == {"complete": False, "unreviewed": [f"edgar:{fx.NPX}"], "retry_next_run": []}
    assert run["reviewed_through_after"] == run["reviewed_through_before"] is None
    assert f"edgar:{fx.NPX}" in run["blocked_by"]
    failure = row["current_state"]["checks"]["checkpoint"]["failures"][f"edgar:{fx.NPX}"]
    assert failure["status"] == "failed_permanent" and failure["attempts"] == ec.MAX_FAILURE_ATTEMPTS


def _with_new_filings(monkeypatch, *filings):
    """SYNTHETIC: the fixture listing plus new 8-Ks (copies of the fixture 8-K text) filed after the baseline."""
    sub = deepcopy(fx.SUBMISSIONS)
    for accession, filed, accepted in filings:
        monkeypatch.setitem(fx.FILES, accession, fx.FILES[fx.EVENT_8K])
        monkeypatch.setitem(fx.HEADERS, accession, (accepted.replace("-", "").replace(":", "").replace("T", "")[:14], "8-K"))
        for key, value in zip(["accessionNumber", "form", "filingDate", "reportDate", "primaryDocument", "items", "acceptanceDateTime"],
                              [accession, "8-K", filed, filed, "fixture-8k.htm", "8.01", f"{accepted}.000Z"]):
            sub["filings"]["recent"][key].append(value)
    sec = fx.FakeSec()
    sec.submissions = lambda cik: sub
    return sec


def _exhaust_npx(client, holder, triage):
    holder["rt"] = cf.runtime(transport=cf.Transport(triage={**triage, fx.NPX: {"classification": "nonsense"}}))
    row = adopt(client)
    for attempt in range(ec.MAX_FAILURE_ATTEMPTS):
        row, _ = check(client, row, f"try-{attempt}")
        if row["current_state"]["pendingId"]:
            row = decide(client, row, "keep_unresolved", f"keep-{attempt}").json()
    return row


def test_an_unresolved_exception_stays_explicit_while_new_filings_are_still_processed(env, monkeypatch):
    """Release closure: an excluded filing never turns later runs clean, and never blocks new filings."""
    client, _, holder = env
    row = _exhaust_npx(client, holder, fx.TRIAGE)
    new = "0001045810-26-900011"
    sec = _with_new_filings(monkeypatch, (new, "2026-10-12", "2026-10-12T20:00:00"))
    # The new filing is irrelevant: absent the exception this run would be a clean "no new material evidence".
    transport = cf.Transport(triage={**fx.TRIAGE, fx.NPX: {"classification": "nonsense"}, new: fx.TRIAGE[fx.NPX]})
    holder["rt"] = cf.runtime(sec=sec, transport=transport)
    for again in range(2):
        row, _ = check(client, row, f"new-{again}")
        run = last_run(row)
        assert run["outcome"] == "incomplete_coverage" and run["reaffirmation"] is None
        assert [x["accession"] for x in run["window"]["unreviewed_after_repeated_failure"]] == [fx.NPX]
        assert run["coverage"]["complete"] is False and run["reviewed_through_after"] is None
    # The new filing was triaged exactly once (first run); the excluded one never again.
    assert [c["accession"] for c in transport.calls] == [new]
    assert f"edgar:{new}" in row["current_state"]["checks"]["checkpoint"]["processed"]
    assert row["current_state"]["checks"]["checkpoint"]["history"][-1]["blocked_by"] == [f"edgar:{fx.NPX}"]


def test_a_new_material_filing_is_assessed_despite_an_unresolved_exception(env, monkeypatch):
    client, _, holder = env
    row = _exhaust_npx(client, holder, fx.TRIAGE)
    assessments = len(row["current_state"]["assessments"])
    new = "0001045810-26-900012"
    sec = _with_new_filings(monkeypatch, (new, "2026-10-13", "2026-10-13T20:00:00"))
    holder["rt"] = cf.runtime(sec=sec, transport=cf.Transport(
        triage={**fx.TRIAGE, fx.NPX: {"classification": "nonsense"}, new: fx.TRIAGE[fx.EVENT_8K]}))
    row, _ = check(client, row, "material")
    run = last_run(row)
    assert run["outcome"] == "assessment_needs_review" and len(row["current_state"]["assessments"]) == assessments + 1
    assert run["coverage"] == {"complete": False, "unreviewed": [f"edgar:{fx.NPX}"], "retry_next_run": []}
    assert run["reaffirmation"] is None and run["reviewed_through_after"] is None


def test_an_unexpected_sec_error_in_the_research_step_never_wedges_the_run(env):
    """Review P2-1: a failing comparison fetch is a recorded, retryable failure, not a 500 loop."""
    client, _, holder = env
    sec = fx.FakeSec()
    original = sec.fetch

    def fetch(url):
        if fx.TENQ.replace("-", "") in url:
            raise fx.SecFetchError(url, "http_429", 2)
        return original(url)
    sec.fetch = fetch
    holder["rt"] = cf.runtime(sec=sec)
    row, _ = check(client, adopt(client))
    event = next(e for e in last_run(row)["events"] if e["accession"] == fx.EVENT_8K)
    assert event["outcome"] == "step_failed" and event["failure"]["status"] == "retry_next_run"
    assert row["current_state"]["checks"]["active"] is None and last_run(row)["reviewed_through_after"] is None


def test_a_model_call_never_starts_too_late_in_a_request(env, monkeypatch):
    client, _, _ = env
    monkeypatch.setattr(check_service, "STEP_BUDGET_SECONDS", -1)
    row, _ = check(client, adopt(client))
    outcomes = {e["outcome"] for e in last_run(row)["events"]}
    assert outcomes == {"triage_blocked"} and last_run(row)["totals"]["model_calls"] == 0


def test_an_empty_or_truncated_sec_listing_is_not_a_clean_review(env):
    """Review P2-2."""
    client, _, holder = env
    sec = fx.FakeSec()
    empty = {"filings": {"recent": {k: [] for k in fx.SUBMISSIONS["filings"]["recent"]}}}
    sec.submissions = lambda cik: empty
    holder["rt"] = cf.runtime(sec=sec)
    row = adopt(client)
    assert step(client, row, "empty").json()["error"]["code"] == "sec_malformed"


def test_a_changed_check_projection_pauses_checks_without_bricking_the_workspace(env, monkeypatch):
    """Review P2-3."""
    client, _, _ = env
    row, _ = check(client, adopt(client))
    monkeypatch.setattr(baseline_lineage, "check_standing_sha256", lambda: "f" * 64)
    assert decide(client, row, "keep_unresolved", "still-decidable").status_code == 200
    again = client.get(f"/api/workspaces/{row['id']}", headers=AUTH_A).json()
    assert step(client, again, "paused").json()["error"]["code"] == "monitoring_rules_changed"


def test_adoption_fails_closed_before_the_migration(env):
    client, repo, _ = env
    repo.check_schema = False
    response = client.post("/api/workspaces/adopt-baseline", headers=AUTH_A, json={"language": "en", "idempotency_key": "k"})
    assert response.status_code == 503 and response.json()["error"]["code"] == "check_unavailable"


def test_a_filing_assessment_stays_decidable_after_a_day(env, monkeypatch):
    client, _, _ = env
    row, _ = check(client, adopt(client))
    import time as real_time
    future = real_time.time() + 3 * 86400
    monkeypatch.setattr(service.time, "time", lambda: future)
    assert decide(client, row, "keep_unresolved", "late").status_code == 200


# ---------------------------------------------------------------- failures, retries and recovery

def test_model_timeout_holds_the_checkpoint_and_the_next_check_recovers(env):
    client, _, holder = env
    holder["rt"] = cf.runtime(transport=cf.Transport(fail={"triage": "model_timeout"}))
    row, _ = check(client, adopt(client))
    run = last_run(row)
    assert run["outcome"] == "partial_failure" and run["reviewed_through_after"] is None
    assert {e["outcome"] for e in run["events"] if e["stage0"]["result"] == "candidate"} == {"triage_blocked"}
    assert row["current_state"]["checks"]["checkpoint"]["processed"] == {}
    assert row["active_thesis_version"] == 1 and row["current_state"]["pendingId"] is None
    holder["rt"] = cf.runtime()
    recovered, _ = check(client, row, "retry")
    assert last_run(recovered)["outcome"] == "assessment_needs_review"
    assert last_run(recovered)["reviewed_through_after"] == last_run(recovered)["as_of"]


def test_invalid_model_json_is_not_a_verdict(env):
    client, _, holder = env
    holder["rt"] = cf.runtime(transport=cf.Transport(fail={"assess": "raw:{\"relevant\": true"}))
    row, _ = check(client, adopt(client))
    run = last_run(row)
    event = next(e for e in run["events"] if e["accession"] == fx.EVENT_8K)
    assert event["outcome"] == "assessed_rejected" and event["failure"]["status"] == "retry_next_run"
    assert row["current_state"]["pendingId"] is None and run["reviewed_through_after"] is None


def test_malformed_or_unreachable_sec_changes_nothing(env):
    client, repo, holder = env
    row = adopt(client)
    sec = fx.FakeSec()
    sec.submissions = lambda cik: {"filings": {}}
    holder["rt"] = cf.runtime(sec=sec)
    response = step(client, row, "bad")
    assert response.status_code == 502 and response.json()["error"]["code"] == "sec_malformed"

    def down(cik):
        raise fx.SecFetchError("https://data.sec.gov/x", "http_429", 2)
    sec.submissions = down
    assert step(client, row, "down").json()["error"]["code"] == "sec_unavailable"
    assert client.get(f"/api/workspaces/{row['id']}", headers=AUTH_A).json() == row


def test_a_failed_filing_fetch_is_recorded_and_retried(env):
    client, _, holder = env
    holder["rt"] = cf.runtime(sec=fx.FakeSec(fail={fx.EVENT_8K}))
    row, _ = check(client, adopt(client))
    event = next(e for e in last_run(row)["events"] if e["accession"] == fx.EVENT_8K)
    assert event["outcome"] == "acquisition_failed" and event["stage0"]["result"] == "failed"
    assert last_run(row)["reviewed_through_after"] is None


def test_an_interrupted_commit_retries_without_losing_or_duplicating(env):
    client, repo, holder = env
    row = adopt(client)
    started = step(client, row, "s0").json()
    original = repo.commit
    state = {"fail": True}

    async def flaky(*args, **kwargs):
        if state["fail"]:
            state["fail"] = False
            raise service.ProductError("cloud_unavailable", "Interrupted.", 503)
        return await original(*args, **kwargs)

    repo.commit = flaky
    assert step(client, started, "s1").status_code == 503
    assert client.get(f"/api/workspaces/{row['id']}", headers=AUTH_A).json() == started   # nothing half-written
    retried = step(client, started, "s1")                     # same key: the step runs again
    assert retried.status_code == 200
    assert step(client, started, "s1").json() == retried.json()  # and is idempotent once committed
    repo.commit = original
    done, _ = check(client, retried.json(), "rest")
    run = last_run(done)
    assert len([e for e in run["events"] if e["stage0"]["result"] == "candidate"]) == 2
    assert len(done["current_state"]["assessments"]) == 1


def test_a_lost_response_does_not_repeat_the_step(env):
    client, repo, holder = env
    row = adopt(client)
    first = step(client, row, "same").json()
    calls = len(holder["rt"].transport.calls)
    assert step(client, row, "same").json() == first and len(holder["rt"].transport.calls) == calls
    assert step(client, row, "other").status_code == 409     # a different retry key against a moved revision


def test_bounded_run_defers_extra_filings_and_holds_the_checkpoint(env, monkeypatch):
    client, _, _ = env
    monkeypatch.setattr(check_service, "MAX_CANDIDATES_PER_RUN", 1)
    row, _ = check(client, adopt(client))
    run = last_run(row)
    assert run["window"]["deferred_to_next_check"] == [fx.EVENT_8K] and run["outcome"] == "partial_failure"
    assert run["reviewed_through_after"] is None
    monkeypatch.setattr(check_service, "MAX_CANDIDATES_PER_RUN", 8)
    row = decide(client, row, "keep_unresolved", "k").json() if row["current_state"]["pendingId"] else row
    again, _ = check(client, row, "next")
    assert last_run(again)["reviewed_through_after"] == last_run(again)["as_of"]


# ---------------------------------------------------------------- deployment gates

def test_check_fails_closed_without_configuration_or_migration(env, monkeypatch):
    client, repo, _ = env
    row = adopt(client)
    monkeypatch.setattr(check_service, "runtime", _real_runtime)
    monkeypatch.setenv("SEC_USER_AGENT", "")
    assert step(client, row, "no-ua").json()["error"]["code"] == "check_unavailable"
    monkeypatch.setenv("SEC_USER_AGENT", "LivingThesis ops@example.test")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "")
    assert step(client, row, "no-key").json()["error"]["code"] == "model_unavailable"
    repo.check_schema = False
    assert step(client, row, "no-schema").status_code == 503
    assert client.get(f"/api/workspaces/{row['id']}", headers=AUTH_A).json() == row


def test_preview_model_route_stays_closed_in_production(monkeypatch):
    monkeypatch.setenv("VERCEL_ENV", "production")
    assert TestClient(app).post("/api/evidence-check/model", json={}).status_code == 404


def test_deployment_ships_every_module_the_check_imports_even_lazily():
    """Release closure: the live Preview returned 500 because .vercelignore omitted sec_client.py (imported
    lazily inside runtime()), so no fixture test could see it. Every backend module reachable from the hosted
    check, including function-level imports, must be on the deployment allowlist."""
    import re
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    package = root / "backend/src/living_thesis"
    lines = (root / ".vercelignore").read_text().splitlines()
    assert "backend/src/living_thesis/*" in lines            # the engine is an allowlist, so omissions are silent
    absolute = [re.compile(r"^\s*from backend\.src\.living_thesis\.(\w+) import", re.M),
                re.compile(r"^\s*from backend\.src\.living_thesis import (\w+)", re.M)]
    relative = re.compile(r"^\s*from \.(\w+) import", re.M)          # inside the engine package only
    found = lambda text, patterns: {m for p in patterns for m in p.findall(text)}
    todo = set()
    for path in (root / "hosted").glob("*.py"):
        todo |= found(path.read_text(), absolute)
    seen = set()
    while todo:
        module = todo.pop()
        if module in seen or not (package / f"{module}.py").exists():
            continue
        seen.add(module)
        todo |= found((package / f"{module}.py").read_text(), absolute + [relative])
    assert {"evidence_check", "sec_client", "xbrl", "models"} <= seen
    missing = sorted(m for m in seen if f"!backend/src/living_thesis/{m}.py" not in lines)
    assert missing == [], f"not deployed: {missing}"
