"""Authenticated domain commands; anonymous routes remain independent."""
from uuid import UUID, uuid4, uuid5

from fastapi import APIRouter, Depends, Header, Path

from . import durable_repository as storage, durable_service as domain
from .durable_models import (CreateWorkspaceRequest, AssessWorkspaceRequest,
                            DecideWorkspaceRequest, ArchiveWorkspaceRequest,
                            ImportWorkspaceRequest, AdoptBaselineRequest,
                            ConfirmMonitoringRequest, CheckWorkspaceRequest)
from .service import ProductError

router = APIRouter(prefix="/api")


async def repository():
    async with storage.open_repository() as repo:
        yield repo


async def bearer(authorization: str | None = Header(default=None)):
    if not authorization or len(authorization) > 8192:
        raise ProductError("auth_required", "Sign in to access your saved theses.", 401)
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise ProductError("auth_required", "Sign in to access your saved theses.", 401)
    return parts[1]


async def identity(token=Depends(bearer), repo=Depends(repository)):
    return await repo.verify_user(token)


@router.get("/auth/config")
async def auth_config():
    if not storage.configured():
        return {"available": False}
    try:
        async with storage.open_repository() as repo:
            if not await repo.schema_ready():
                return {"available": False}
    except Exception:
        return {"available": False}
    config = storage.settings()
    # Explicit allowlist: a server key is never serialized.
    return {"available": True, "supabase_url": config["url"], "publishable_key": config["publishable"]}


@router.get("/workspaces")
async def workspaces(owner=Depends(identity), repo=Depends(repository)):
    return {"workspaces": await repo.list(owner)}


@router.post("/workspaces")
async def create_workspace(request: CreateWorkspaceRequest, owner=Depends(identity), repo=Depends(repository)):
    state, events = domain.create_workspace(request, workspace_id=str(uuid4()))
    return await repo.create(owner, state, events, request.idempotency_key, domain.request_digest(request, "create"))


@router.post("/workspaces/import")
async def import_workspace(request: ImportWorkspaceRequest, owner=Depends(identity), repo=Depends(repository)):
    state, events = domain.import_workspace(request, workspace_id=str(uuid4()))
    return await repo.create(owner, state, events, request.idempotency_key,
                             domain.request_digest(request, "import"), import_key=request.workspace["id"])


@router.get("/workspaces/{workspace_id}")
async def get_workspace(workspace_id: UUID, owner=Depends(identity), repo=Depends(repository)):
    return await repo.fetch(owner, workspace_id)


async def mutate(operation, workspace_id, request, owner, repo):
    digest = domain.request_digest(request, operation)
    # A successful retry is consulted before validation against the new revision.
    prior = await repo.retry(owner, workspace_id, request.idempotency_key, digest)
    if prior is not None:
        return prior
    workspace = await repo.fetch(owner, workspace_id)
    domain.validate_concurrency(workspace, request)
    if operation == "assess":
        state, events = await domain.assess_workspace(workspace, request)
    elif operation == "check":
        from . import check_service
        state, events = await check_service.advance(workspace, request)
    elif operation == "monitoring":
        from . import check_service
        state, events = check_service.confirm_monitoring(workspace, request)
    elif operation == "decision":
        state, events = domain.decide_workspace(workspace, request)
    else:
        state, events = domain.archive_workspace(workspace, request)
    # The final DB transaction rechecks ownership/CAS/retry after any model wait.
    return await repo.commit(owner, workspace_id, request, digest, state, events)


@router.post("/workspaces/{workspace_id}/assess")
async def assess_workspace(workspace_id: UUID, request: AssessWorkspaceRequest,
                           owner=Depends(identity), repo=Depends(repository)):
    return await mutate("assess", workspace_id, request, owner, repo)


@router.post("/workspaces/{workspace_id}/decision")
async def decide_workspace(workspace_id: UUID, request: DecideWorkspaceRequest,
                           owner=Depends(identity), repo=Depends(repository)):
    return await mutate("decision", workspace_id, request, owner, repo)


@router.post("/workspaces/{workspace_id}/archive")
async def archive_workspace(workspace_id: UUID, request: ArchiveWorkspaceRequest,
                            owner=Depends(identity), repo=Depends(repository)):
    return await mutate("archive", workspace_id, request, owner, repo)


# ---------------------------------------------------------------- NVIDIA baseline adoption and Check for Updates

ADOPTION_NAMESPACE = UUID("6f1d2c3a-5b7e-4a90-8c1d-2e3f4a5b6c7d")


@router.post("/workspaces/adopt-baseline")
async def adopt_baseline(request: AdoptBaselineRequest, owner=Depends(identity), repo=Depends(repository)):
    """Adopt the Owner-approved NVIDIA baseline. The server builds Standing v1; the client sends no thesis text."""
    await check_schema(repo)
    # Deterministic per (owner, retry key): a retry finds its own workspace, never a second one.
    workspace_id = str(uuid5(ADOPTION_NAMESPACE, f"{owner}:{request.idempotency_key}"))
    existing = [row for row in await repo.list(owner) if row["current_state"]["standing"]["ticker"] == "NVDA"]
    if any(row["id"] != workspace_id for row in existing):
        # One workspace per ticker; an existing NVDA thesis is never migrated or replaced.
        raise ProductError("duplicate_ticker", "You already have an NVDA workspace. Open it instead.", 409)
    state, events = domain.adopt_baseline(request, workspace_id=workspace_id)
    return await repo.create(owner, state, events, request.idempotency_key, domain.request_digest(request, "adopt"))


async def check_schema(repo):
    if not await repo.check_schema_ready():
        raise ProductError("check_unavailable", "Check for Updates is not available on this deployment yet.", 503)


@router.post("/workspaces/{workspace_id}/monitoring/confirm")
async def confirm_monitoring(workspace_id: UUID, request: ConfirmMonitoringRequest,
                             owner=Depends(identity), repo=Depends(repository)):
    await check_schema(repo)
    return await mutate("monitoring", workspace_id, request, owner, repo)


@router.post("/workspaces/{workspace_id}/check")
async def check_workspace(workspace_id: UUID, request: CheckWorkspaceRequest,
                          owner=Depends(identity), repo=Depends(repository)):
    """Start a check or advance it by one bounded step. The browser repeats until no run is active."""
    await check_schema(repo)
    return await mutate("check", workspace_id, request, owner, repo)


@router.get("/workspaces/{workspace_id}/checks/{run_id}")
async def check_run(workspace_id: UUID, run_id: str = Path(pattern=r"^chk_\d{8}T\d{6}Z_[0-9a-f]{6}$"),
                    owner=Depends(identity), repo=Depends(repository)):
    from . import check_service
    return check_service.run_record(await repo.check_events(owner, workspace_id, run_id), run_id)
