"""Bounded durable-domain contracts. UI state and ownership are not client mutations."""
from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import ConfigDict, Field, StrictBool, StrictInt, field_validator, model_validator

from backend.src.living_thesis.mvp_models import StrictModel, ThesisDecision
from .models import Assessment, HostedEvidence, OriginalText, Standing


Identifier = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")]
Language = Literal["en", "zh"]
Action = Literal["accept", "edit", "reject", "keep_unresolved"]
Stamp = Annotated[str, Field(min_length=10, max_length=40)] | None
Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


class DurableModel(StrictModel):
    # Imported source/authored bytes must never be silently normalized.
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)


class CreateWorkspaceRequest(DurableModel):
    standing: Standing
    authored: OriginalText = Field(min_length=10, max_length=2000)
    language: Language = "en"
    idempotency_key: Identifier

    @model_validator(mode="after")
    def confirmed_initial_version(self):
        if self.standing.version != 1 or len(self.authored.strip()) < 10:
            raise ValueError("A confirmed workspace starts at version one")
        return self


class ConcurrentRequest(DurableModel):
    expected_revision: StrictInt = Field(ge=1)
    expected_thesis_version: StrictInt = Field(ge=1, le=10000)
    idempotency_key: Identifier


class AssessWorkspaceRequest(ConcurrentRequest):
    evidence: HostedEvidence
    language: Language = "en"


class DecideWorkspaceRequest(ConcurrentRequest):
    assessment_id: Identifier
    action: Action
    edited_statement: str | None = Field(default=None, min_length=10, max_length=2000)

    @model_validator(mode="after")
    def decision_semantics(self):
        ThesisDecision(thesis_id="T1", assessment_id=self.assessment_id,
                       action=self.action, edited_statement=self.edited_statement)
        if self.edited_statement is not None and not 10 <= len(self.edited_statement.strip()) <= 2000:
            raise ValueError("Invalid edited statement")
        return self


class ArchiveWorkspaceRequest(ConcurrentRequest):
    pass


class AdoptBaselineRequest(DurableModel):
    # The client chooses only the language. The Standing comes from the server's approved projection.
    language: Language = "en"
    idempotency_key: Identifier


class ConfirmMonitoringRequest(ConcurrentRequest):
    pass


class CheckWorkspaceRequest(ConcurrentRequest):
    pass


class MonitoringConfirmation(DurableModel):
    version: StrictInt = Field(ge=1, le=10000)
    statement_sha256: Sha256
    basis: Literal["adoption", "investor_confirmed"]
    time: Stamp


class Lineage(DurableModel):
    kind: Literal["owner_approved_baseline"]
    baseline_id: Literal["NVDA_PRODUCT_BASELINE_V1"]
    baseline_content_sha256: Sha256
    check_standing_sha256: Sha256
    approval_recorded_at: str = Field(min_length=20, max_length=40)
    language: Language
    adopted_at: Stamp
    adopted_standing_sha256: Sha256
    monitoring: list[MonitoringConfirmation] = Field(min_length=1, max_length=10000)


class CheckState(DurableModel):
    # Server-written only; hosted/check_service.py owns its inner shape.
    schema_version: Literal["workspace-checks-0.1"]
    checkpoint: dict
    active: dict | None = None
    runs: list[dict] = Field(max_length=50)


class StoredEvidenceContent(DurableModel):
    event_date: str = Field(min_length=10, max_length=10)
    information: OriginalText = Field(min_length=3, max_length=10000)
    source: OriginalText = Field(min_length=2, max_length=1000)
    source_text: OriginalText = Field(min_length=3, max_length=50000)
    language: Language | None = None

    @field_validator("event_date")
    @classmethod
    def valid_date(cls, value):
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError("Invalid evidence date")
        return value

    @model_validator(mode="after")
    def meaningful(self):
        if len(self.information.strip()) < 3 or len(self.source.strip()) < 2 or len(self.source_text.strip()) < 3:
            raise ValueError("Empty evidence")
        return self


class VersionSnapshot(DurableModel):
    standing: Standing
    time: Stamp


class EvidenceRecord(DurableModel):
    id: Identifier
    content: StoredEvidenceContent
    time: Stamp
    event: str | None = Field(default=None, max_length=80)
    sourceVerified: Literal[False] = False
    synthetic: Literal[False] = False
    status: Literal["pending", "failed", "assessed", "superseded", "unresolved", "decided"]
    assessmentId: Identifier | None = None
    # Present only for a filing the server acquired from SEC EDGAR during Check for Updates.
    acquisition: dict | None = None


class AssessmentRecord(DurableModel):
    id: Identifier
    evidenceId: Identifier
    payload: Assessment
    receipt: str | None = Field(default=None, max_length=300)
    language: Language = "en"
    time: Stamp
    baseStanding: Standing
    status: Literal["pending", "superseded", "unresolved", "decided"]
    evidenceDigest: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    imported: StrictBool = False
    importedOriginalStatus: Literal["pending", "superseded", "unresolved", "decided"] | None = None
    # Present only for an assessment produced by Check for Updates (Run Record provenance).
    check: dict | None = None


class DecisionRecord(DurableModel):
    assessmentId: Identifier | None
    action: Action
    changed: StrictBool
    fromVersion: StrictInt = Field(ge=1, le=10000)
    version: StrictInt = Field(ge=1, le=10000)
    statement: str | None = Field(default=None, min_length=10, max_length=2000)
    time: Stamp


class CreatedHistory(DurableModel):
    type: Literal["created"]
    version: StrictInt = Field(ge=1, le=10000)
    time: Stamp


class AssessedHistory(DurableModel):
    type: Literal["assessed"]
    assessmentId: Identifier
    evidenceId: Identifier
    version: StrictInt = Field(ge=1, le=10000)
    time: Stamp


class DecisionHistory(DurableModel):
    type: Literal["decision"]
    assessmentId: Identifier
    action: Action
    changed: StrictBool
    fromVersion: StrictInt = Field(ge=1, le=10000)
    version: StrictInt = Field(ge=1, le=10000)
    time: Stamp


class LegacyDecision(DurableModel):
    decision: Action
    changed: StrictBool
    version: StrictInt = Field(ge=1, le=10000)
    # v0.6 history copied the original evidence summary and source label. v0.6.1
    # migration deliberately retained those records verbatim, including whitespace.
    title: OriginalText | None = Field(default=None, min_length=3, max_length=10000)
    source: OriginalText | None = Field(default=None, min_length=2, max_length=1000)


class LegacyHistory(DurableModel):
    type: Literal["legacy"]
    time: None = None
    records: list[LegacyDecision] = Field(max_length=1000)


HistoryRecord = Annotated[CreatedHistory | AssessedHistory | DecisionHistory | LegacyHistory,
                          Field(discriminator="type")]


class DurableWorkspaceState(DurableModel):
    id: Identifier
    mode: Literal["custom"] = "custom"
    standing: Standing
    authored: OriginalText = Field(min_length=10, max_length=2000)
    language: Language
    createdAt: Stamp
    updatedAt: Stamp
    versions: list[VersionSnapshot] = Field(min_length=1, max_length=10000)
    evidence: list[EvidenceRecord] = Field(max_length=1000)
    assessments: list[AssessmentRecord] = Field(max_length=1000)
    decisions: list[DecisionRecord] = Field(max_length=10000)
    pendingId: Identifier | None
    history: list[HistoryRecord] = Field(min_length=1, max_length=20001)
    lineage: Lineage | None = None
    checks: CheckState | None = None

    @model_validator(mode="after")
    def valid_stamps(self):
        values = [self.createdAt, self.updatedAt]
        for group in (self.versions, self.evidence, self.assessments, self.decisions, self.history):
            values.extend(record.time for record in group)
        for value in values:
            if value is not None:
                datetime.fromisoformat(value.replace("Z", "+00:00"))
        if len(self.authored.strip()) < 10:
            raise ValueError("Empty authored thesis")
        return self


class WorkspaceRecord(DurableModel):
    id: Identifier
    revision: StrictInt = Field(ge=1)
    active_thesis_version: StrictInt = Field(ge=1, le=10000)
    current_state: DurableWorkspaceState
    created_at: str
    updated_at: str
    archived_at: str | None = None

    @model_validator(mode="after")
    def coherent(self):
        if self.id != self.current_state.id or self.active_thesis_version != self.current_state.standing.version:
            raise ValueError("Workspace identity/version mismatch")
        return self


class ImportWorkspaceRequest(DurableModel):
    # Validate the allowlisted domain after explicitly removing known UI metadata.
    workspace: dict
    idempotency_key: Identifier


class DomainEvent(DurableModel):
    event_type: Literal["workspace_created", "session_imported", "evidence_added", "assessment_created",
                        "decision_accepted", "decision_edited", "decision_rejected",
                        "decision_kept_unresolved", "thesis_revised", "workspace_archived",
                        "baseline_adopted", "monitoring_confirmed", "check_started", "check_stage_recorded",
                        "check_completed"]
    payload: dict
