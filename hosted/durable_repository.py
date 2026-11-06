"""Supabase boundary. No user session is ever installed on a privileged client."""
import os
from contextlib import asynccontextmanager
from uuid import UUID

import httpx
from postgrest.exceptions import APIError
from supabase import acreate_client
from supabase.lib.client_options import AsyncClientOptions
from supabase_auth.errors import AuthApiError

from .service import ProductError

FIELDS = "id,revision,active_thesis_version,current_state,created_at,updated_at,archived_at"


def settings():
    return {"url": os.environ.get("SUPABASE_URL", "").strip().rstrip("/"),
            "publishable": os.environ.get("SUPABASE_PUBLISHABLE_KEY", "").strip(),
            "secret": os.environ.get("SUPABASE_SECRET_KEY", "").strip()}


def configured():
    return all(settings().values())


def unavailable():
    return ProductError("cloud_unavailable", "Cloud saving is temporarily unavailable. Your local work is retained.", 503)


@asynccontextmanager
async def open_repository():
    config = settings()
    if not all(config.values()):
        raise unavailable()
    # One immutable service client per request, with bounded connections/timeouts.
    async with httpx.AsyncClient(timeout=httpx.Timeout(15, connect=8), trust_env=False) as transport:
        client = await acreate_client(config["url"], config["secret"], options=AsyncClientOptions(
            auto_refresh_token=False, persist_session=False, httpx_client=transport,
            postgrest_client_timeout=15))
        yield SupabaseRepository(client)


class SupabaseRepository:
    def __init__(self, client):
        self.client = client

    async def verify_user(self, token):
        try:
            result = await self.client.auth.get_user(token)
            if not result.user or result.user.is_anonymous:
                raise ValueError("Not an investor account")
            return str(UUID(result.user.id))
        except AuthApiError as exc:
            if exc.status in (400, 401, 403):
                raise ProductError("auth_required", "Sign in again to access your saved theses.", 401) from None
            raise unavailable() from None
        except (ValueError, TypeError):
            raise ProductError("auth_required", "Sign in again to access your saved theses.", 401) from None
        except httpx.HTTPError:
            raise unavailable() from None

    async def run(self, query):
        try:
            return (await query.execute()).data
        except APIError as exc:
            code = exc.code
            if code == "PT404":
                raise ProductError("workspace_not_found", "This workspace is unavailable.", 404) from None
            if code == "PT409":
                reason = exc.message
                if reason == "idempotency_conflict":
                    raise ProductError(reason, "This retry differs from the original request. Reload the workspace.", 409) from None
                raise ProductError("stale_workspace", "This workspace changed. Reload the latest version and reassess before deciding.", 409) from None
            if code == "PT400":
                raise ProductError("invalid_input", "Check the workspace fields and try again.", 422) from None
            raise unavailable() from None
        except httpx.HTTPError:
            raise unavailable() from None

    async def schema_ready(self):
        try:
            return await self.run(self.client.rpc("v07_schema_version", {})) == 1
        except ProductError:
            return False

    async def check_schema_ready(self):
        """Check for Updates needs migration 202610180001 (new event types). Absent -> fail closed."""
        try:
            return await self.run(self.client.rpc("v08_check_schema_version", {})) == 1
        except ProductError:
            return False

    async def check_events(self, owner, workspace_id, run_id):
        """One check run's Run Record parts, in commit order. Ownership is checked first."""
        await self.fetch(owner, workspace_id)
        rows, offset = [], 0
        while True:
            batch = await self.run(self.client.table("workspace_events").select("sequence,event_type,payload,created_at")
                                   .eq("workspace_id", str(workspace_id))
                                   .in_("event_type", ["check_started", "check_stage_recorded", "check_completed"])
                                   .eq("payload->>run_id", run_id)
                                   .order("sequence").range(offset, offset + 49))
            rows.extend(batch)
            if len(batch) < 50:
                return rows
            offset += 50

    async def list(self, owner):
        # Pagination is deterministic and never mixes ownership with client filters.
        rows, offset = [], 0
        while True:
            batch = await self.run(self.client.table("workspaces").select(FIELDS)
                                   .eq("user_id", owner).is_("archived_at", "null")
                                   .order("id").range(offset, offset + 49))
            rows.extend(batch)
            if len(batch) < 50:
                return rows
            offset += 50

    async def fetch(self, owner, workspace_id):
        rows = await self.run(self.client.table("workspaces").select(FIELDS)
                              .eq("user_id", owner).eq("id", str(workspace_id)).limit(1))
        if not rows:
            raise ProductError("workspace_not_found", "This workspace is unavailable.", 404)
        return rows[0]

    async def retry(self, owner, workspace_id, key, digest):
        return await self.run(self.client.rpc("v07_mutation_result", {
            "p_owner_id": owner, "p_workspace_id": str(workspace_id),
            "p_idempotency_key": key, "p_request_digest": digest}))

    async def create(self, owner, state, events, key, digest, import_key=None):
        return await self.run(self.client.rpc("v07_create_workspace", {
            "p_owner_id": owner, "p_workspace_id": state["id"],
            "p_ticker": state["standing"]["ticker"], "p_idempotency_key": key,
            "p_request_digest": digest, "p_initial_state": state,
            "p_events": events, "p_import_key": import_key}))

    async def commit(self, owner, workspace_id, request, digest, state, events):
        return await self.run(self.client.rpc("v07_commit_workspace", {
            "p_owner_id": owner, "p_workspace_id": str(workspace_id),
            "p_expected_revision": request.expected_revision,
            "p_expected_thesis_version": request.expected_thesis_version,
            "p_idempotency_key": request.idempotency_key,
            "p_request_digest": digest, "p_next_state": state, "p_events": events}))
