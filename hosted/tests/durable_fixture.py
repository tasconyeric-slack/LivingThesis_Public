"""Deterministic transactional fixture, never a deployed storage fallback."""
from copy import deepcopy
from datetime import datetime, timezone
from threading import RLock

from hosted.service import ProductError

USER_A = "11111111-1111-4111-8111-111111111111"
USER_B = "22222222-2222-4222-8222-222222222222"


class MemoryRepository:
    def __init__(self):
        self.rows, self.owners, self.events, self.outcomes, self.creates, self.imports = {}, {}, {}, {}, {}, {}
        self.lock = RLock()

    async def verify_user(self, token):
        if token not in {"fixture-user-a", "fixture-user-b"}:
            raise ProductError("auth_required", "Sign in again.", 401)
        return USER_A if token == "fixture-user-a" else USER_B

    async def schema_ready(self):
        return True

    check_schema = True

    async def check_schema_ready(self):
        return self.check_schema

    async def check_events(self, owner, workspace_id, run_id):
        id = str(workspace_id)
        with self.lock:
            await self.fetch(owner, id)
            return deepcopy([{"sequence": index + 1, **event} for index, event in enumerate(self.events[id])
                             if event["event_type"].startswith("check_") and event["payload"].get("run_id") == run_id])

    async def list(self, owner):
        with self.lock:
            return deepcopy([r for id, r in self.rows.items() if self.owners[id] == owner and not r["archived_at"]])

    async def fetch(self, owner, workspace_id):
        id = str(workspace_id)
        with self.lock:
            if self.owners.get(id) != owner:
                raise ProductError("workspace_not_found", "Workspace unavailable.", 404)
            return deepcopy(self.rows[id])

    async def retry(self, owner, workspace_id, key, digest):
        id = str(workspace_id)
        with self.lock:
            await self.fetch(owner, id)
            prior = self.outcomes.get((id, key))
            if prior:
                if prior[0] != digest:
                    raise ProductError("idempotency_conflict", "Retry differs.", 409)
                return deepcopy(prior[1])

    async def create(self, owner, state, events, key, digest, import_key=None):
        with self.lock:
            prior = self.creates.get((owner, key))
            if prior:
                if prior[0] != digest:
                    raise ProductError("idempotency_conflict", "Retry differs.", 409)
                return deepcopy(prior[1])
            imported = self.imports.get((owner, import_key)) if import_key else None
            if imported:
                if imported[0] != digest:
                    raise ProductError("idempotency_conflict", "Import differs.", 409)
                return deepcopy(self.rows[imported[1]])
            stamp = datetime.now(timezone.utc).isoformat()
            row = {"id": state["id"], "revision": 1, "active_thesis_version": state["standing"]["version"],
                   "current_state": deepcopy(state), "created_at": stamp, "updated_at": stamp, "archived_at": None}
            self.rows[row["id"]], self.owners[row["id"]] = row, owner
            self.events[row["id"]] = deepcopy(events)
            self.creates[(owner, key)] = (digest, deepcopy(row))
            if import_key:
                self.imports[(owner, import_key)] = (digest, row["id"])
            return deepcopy(row)

    async def commit(self, owner, workspace_id, request, digest, state, events):
        id = str(workspace_id)
        with self.lock:
            prior = await self.retry(owner, id, request.idempotency_key, digest)
            if prior:
                return prior
            row = await self.fetch(owner, id)
            if row["archived_at"] or row["revision"] != request.expected_revision or row["active_thesis_version"] != request.expected_thesis_version:
                raise ProductError("stale_workspace", "Reload latest.", 409)
            row["revision"] += 1
            row["active_thesis_version"] = state["standing"]["version"]
            row["current_state"] = deepcopy(state)
            row["updated_at"] = datetime.now(timezone.utc).isoformat()
            if any(e["event_type"] == "workspace_archived" for e in events):
                row["archived_at"] = row["updated_at"]
            self.rows[id] = row
            self.events[id].extend(deepcopy(events))
            self.outcomes[(id, request.idempotency_key)] = (digest, deepcopy(row))
            return deepcopy(row)
