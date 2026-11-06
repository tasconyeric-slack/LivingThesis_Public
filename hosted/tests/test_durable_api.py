from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from api.index import app
from hosted import durable_api, service
from hosted.models import Assessment
from hosted.tests.durable_fixture import MemoryRepository
from hosted.tests.test_hosted_api import standing, evidence, assessment


@pytest.fixture
def durable(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-durable-receipt-key")
    repo = MemoryRepository()
    async def fixture_repository():
        yield repo
    async def model_json(*args):
        return Assessment.model_validate(assessment())
    monkeypatch.setattr(service, "model_json", model_json)
    app.dependency_overrides[durable_api.repository] = fixture_repository
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client, repo
    app.dependency_overrides.clear()


AUTH_A = {"Authorization": "Bearer fixture-user-a"}
AUTH_B = {"Authorization": "Bearer fixture-user-b"}


def create(client, key="create-1", headers=AUTH_A):
    response = client.post("/api/workspaces", headers=headers, json={"standing": standing(),
        "authored": standing()["statement"], "language": "en", "idempotency_key": key})
    assert response.status_code == 200, response.text
    return response.json()


def assess(client, workspace, key="assess-1"):
    response = client.post(f"/api/workspaces/{workspace['id']}/assess", headers=AUTH_A, json={
        "evidence": evidence(), "expected_revision": workspace["revision"],
        "expected_thesis_version": workspace["active_thesis_version"], "idempotency_key": key})
    assert response.status_code == 200, response.text
    return response.json()


def command(workspace, action="accept", key="decision-1"):
    return {"assessment_id": workspace["current_state"]["pendingId"], "action": action,
            "expected_revision": workspace["revision"],
            "expected_thesis_version": workspace["active_thesis_version"], "idempotency_key": key}


def test_authenticated_recovery_and_owner_isolation(durable):
    client, repo = durable
    row = create(client)
    assert client.get("/api/workspaces", headers=AUTH_A).json()["workspaces"] == [row]
    assert client.get("/api/workspaces", headers=AUTH_B).json()["workspaces"] == []
    path = f"/api/workspaces/{row['id']}"
    assert client.get(path, headers=AUTH_A).json() == row
    assert client.get(path, headers=AUTH_B).status_code == 404
    assert client.get(path).status_code == 401
    assert client.get(path, headers={"Authorization": "Bearer forged"}).status_code == 401
    assert client.get(f"/api/workspaces/{uuid4()}", headers=AUTH_A).status_code == 404
    for operation in ("assess", "decision", "archive"):
        body = {"expected_revision": 1, "expected_thesis_version": 1, "idempotency_key": "attack"}
        if operation == "assess": body["evidence"] = evidence()
        if operation == "decision": body.update(assessment_id="forged-assessment", action="reject")
        response = client.post(path + "/" + operation, headers=AUTH_B, json=body)
        assert response.status_code == 404
        assert response.headers["cache-control"] == "no-store"
    assert client.get(path, headers=AUTH_A).json() == row


@pytest.mark.parametrize("action,version", [("accept", 2), ("edit", 2), ("reject", 1), ("keep_unresolved", 1)])
def test_decision_and_retry_preserve_versions(durable, action, version):
    client, repo = durable
    row = assess(client, create(client))
    body = command(row, action)
    if action == "edit": body["edited_statement"] = "Investor-authored later execution with durable demand."
    path = f"/api/workspaces/{row['id']}/decision"
    response = client.post(path, headers=AUTH_A, json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["revision"] == 3
    assert result["active_thesis_version"] == version
    assert len(result["current_state"]["versions"]) == version
    assert len(result["current_state"]["decisions"]) == 1
    assert client.post(path, headers=AUTH_A, json=body).json() == result
    conflicting = {**body, "action": "reject" if action != "reject" else "keep_unresolved"}
    conflicting.pop("edited_statement", None)
    assert client.post(path, headers=AUTH_A, json=conflicting).status_code == 409
    assert len(repo.rows[row["id"]]["current_state"]["decisions"]) == 1


def test_two_tabs_fail_closed_without_lost_update(durable):
    client, repo = durable
    row = create(client)
    bodies = [{"evidence": evidence(), "expected_revision": 1, "expected_thesis_version": 1,
               "idempotency_key": key} for key in ("tab-a", "tab-b")]
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda body: client.post(f"/api/workspaces/{row['id']}/assess", headers=AUTH_A, json=body), bodies))
    assert sorted(r.status_code for r in results) == [200, 409]
    current = client.get(f"/api/workspaces/{row['id']}", headers=AUTH_A).json()
    assert current["revision"] == 2
    assert len(current["current_state"]["evidence"]) == 1
    assert len(current["current_state"]["assessments"]) == 1


def test_expired_receipt_does_not_commit(durable, monkeypatch):
    client, repo = durable
    row = assess(client, create(client))
    monkeypatch.setattr(service.time, "time", lambda: 9999999999)
    response = client.post(f"/api/workspaces/{row['id']}/decision", headers=AUTH_A, json=command(row))
    assert response.status_code == 409
    assert repo.rows[row["id"]] == row


def test_explicit_import_deduplicates_and_rejects_invalid_graph(durable):
    client, repo = durable
    local = create(client)["current_state"]
    local["id"] = "local-custom-workspace"
    local.update(action=None, draft={"information": "unsaved recovery draft"})
    body = {"workspace": local, "idempotency_key": "import-1"}
    imported = client.post("/api/workspaces/import", headers=AUTH_A, json=body)
    assert imported.status_code == 200, imported.text
    assert imported.json()["current_state"]["standing"] == local["standing"]
    repeated = client.post("/api/workspaces/import", headers=AUTH_A, json={**body, "idempotency_key": "import-2"})
    assert repeated.json() == imported.json()
    assert len(repo.rows) == 2
    invalid = deepcopy(body)
    invalid["workspace"]["standing"]["version"] = 9
    invalid["idempotency_key"] = "invalid-import"
    assert client.post("/api/workspaces/import", headers=AUTH_A, json=invalid).status_code == 422
    assert len(repo.rows) == 2
    assert local["draft"]["information"] == "unsaved recovery draft"


def test_archive_and_create_retries_are_idempotent(durable):
    client, repo = durable
    row = create(client)
    assert create(client) == row
    body = {"expected_revision": 1, "expected_thesis_version": 1, "idempotency_key": "archive-1"}
    path = f"/api/workspaces/{row['id']}/archive"
    archived = client.post(path, headers=AUTH_A, json=body)
    assert archived.status_code == 200
    assert archived.json()["archived_at"]
    assert client.post(path, headers=AUTH_A, json=body).json() == archived.json()
    assert client.get("/api/workspaces", headers=AUTH_A).json()["workspaces"] == []


def test_auth_config_never_serializes_secret(durable, monkeypatch):
    client, repo = durable
    monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.invalid")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "public-fixture")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "private-do-not-expose")
    from contextlib import asynccontextmanager
    from hosted import durable_repository
    @asynccontextmanager
    async def open_fixture(): yield repo
    monkeypatch.setattr(durable_repository, "open_repository", open_fixture)
    response = client.get("/api/auth/config")
    assert response.json() == {"available": True, "supabase_url": "https://test.supabase.invalid", "publishable_key": "public-fixture"}
    assert "private-do-not-expose" not in response.text
    assert response.headers["cache-control"] == "no-store"
