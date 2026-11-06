from __future__ import annotations

import re
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


ThesisStatus = Literal["strong", "weak", "mixed", "unresolved"]
EvidenceRelation = Literal["support", "weaken", "contradict", "unresolved"]
Materiality = Literal["low", "medium", "high"]
DecisionAction = Literal["accept", "edit", "reject", "keep_unresolved"]
PublishStatus = Literal["validated", "needs_review", "rejected"]
ARTIFACT_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ThesisDriver(StrictModel):
    driver_id: str = Field(min_length=1, max_length=40)
    statement: str = Field(min_length=3, max_length=800)
    falsifiers: list[str] = Field(default_factory=list, max_length=5)


class GenericThesis(StrictModel):
    thesis_id: str = Field(min_length=1, max_length=40)
    statement: str = Field(min_length=3, max_length=2000)
    drivers: list[ThesisDriver] = Field(min_length=1, max_length=5)
    falsifiers: list[str] = Field(min_length=1, max_length=5)
    status: ThesisStatus = "unresolved"
    version: int = Field(default=1, ge=1)
    assessment_reasoning: str = Field(min_length=3, max_length=2000)
    citations: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def unique_driver_ids(self):
        ids = [driver.driver_id for driver in self.drivers]
        if len(ids) != len(set(ids)):
            raise ValueError("driver_id values must be unique within a thesis")
        return self


class GenericStandingThesis(StrictModel):
    schema_version: Literal["thesis-mvp-1.0"] = "thesis-mvp-1.0"
    ticker: str = Field(min_length=1, max_length=12)
    version: int = Field(default=1, ge=1)
    confirmed: bool = False
    theses: list[GenericThesis] = Field(min_length=1, max_length=5)

    @field_validator("ticker")
    @classmethod
    def normalize_ticker(cls, value: str) -> str:
        ticker = value.strip().upper()
        if not re.fullmatch(r"[A-Z0-9.\-]{1,12}", ticker):
            raise ValueError("ticker must use 1-12 letters, digits, dots, or hyphens")
        return ticker

    @model_validator(mode="after")
    def unique_thesis_ids(self):
        ids = [thesis.thesis_id for thesis in self.theses]
        if len(ids) != len(set(ids)):
            raise ValueError("thesis_id values must be unique")
        return self


class CreateThesisRequest(StrictModel):
    ticker: str = Field(min_length=1, max_length=12)
    statements: list[str] = Field(min_length=1, max_length=5)
    language: Literal["en", "zh"] = "en"

    @field_validator("ticker")
    @classmethod
    def normalize_ticker(cls, value: str) -> str:
        return GenericStandingThesis.normalize_ticker(value)

    @field_validator("statements")
    @classmethod
    def validate_statements(cls, values: list[str]) -> list[str]:
        cleaned = [value.strip() for value in values]
        if any(len(value) < 3 for value in cleaned):
            raise ValueError("each thesis statement must contain at least 3 characters")
        if len(cleaned) != len(set(cleaned)):
            raise ValueError("duplicate thesis statements are not allowed")
        return cleaned


class DriverStructureProposal(StrictModel):
    statement: str = Field(min_length=3, max_length=800)
    falsifiers: list[str] = Field(min_length=1, max_length=5)


class ThesisStructureProposal(StrictModel):
    input_index: int = Field(ge=0, le=4)
    drivers: list[DriverStructureProposal] = Field(min_length=1, max_length=5)
    falsifiers: list[str] = Field(min_length=1, max_length=5)
    decomposition_reasoning: str = Field(min_length=3, max_length=1600)


class ThesisStructurePayload(StrictModel):
    theses: list[ThesisStructureProposal] = Field(min_length=1, max_length=5)


class EvidenceInput(StrictModel):
    event_date: date
    information: str = Field(min_length=3, max_length=10000)
    source: str = Field(min_length=2, max_length=1000)
    source_text: str = Field(min_length=3, max_length=50000)
    language: Literal["en", "zh"] = "en"


class TestEvidenceRequest(EvidenceInput):
    thesis_state_id: str = Field(pattern=ARTIFACT_ID_PATTERN)


class ConfirmThesisRequest(StrictModel):
    draft_run_id: str = Field(pattern=ARTIFACT_ID_PATTERN)
    standing_thesis: GenericStandingThesis


class AssessResearchRequest(StrictModel):
    thesis_state_id: str = Field(pattern=ARTIFACT_ID_PATTERN)
    packet_id: str = Field(pattern=ARTIFACT_ID_PATTERN)
    language: Literal["en", "zh"] = "en"


class EvidenceCitation(StrictModel):
    evidence_id: str = Field(min_length=1, max_length=40)
    exact_quote: str = Field(min_length=3, max_length=1600)


class GroundedReasoningClaim(StrictModel):
    text: str = Field(min_length=3, max_length=1600)
    fact_id: str = Field(min_length=1, max_length=128)
    citation: EvidenceCitation


class DriverEvidenceImpact(StrictModel):
    driver_id: str = Field(min_length=1, max_length=40)
    relation: EvidenceRelation
    materiality: Materiality
    reasoning: str = Field(min_length=3, max_length=1600)
    claims: list[GroundedReasoningClaim] = Field(default_factory=list, max_length=8)


class CounterEvidence(StrictModel):
    status: Literal["found", "none_in_evidence", "none_in_packet", "not_assessable"]
    reasoning: str = Field(min_length=3, max_length=1600)
    fact_ids: list[str] = Field(default_factory=list, max_length=8)
    citations: list[EvidenceCitation] = Field(default_factory=list, max_length=8)


class GenericProposedChange(StrictModel):
    action: Literal["revise", "no_change", "hold_unresolved"]
    revised_statement: str | None = Field(default=None, max_length=2000)
    reason: str = Field(min_length=3, max_length=1600)

    @model_validator(mode="after")
    def revision_has_statement(self):
        if self.action == "revise" and not self.revised_statement:
            raise ValueError("revise requires revised_statement")
        if self.action != "revise" and self.revised_statement:
            raise ValueError("only revise may include revised_statement")
        return self


class EvidenceAssessmentPayload(StrictModel):
    relation: EvidenceRelation
    materiality: Materiality
    reasoning: str = Field(min_length=3, max_length=2000)
    claims: list[GroundedReasoningClaim] = Field(default_factory=list, max_length=10)
    driver_impacts: list[DriverEvidenceImpact] = Field(default_factory=list, max_length=5)
    counter_evidence: CounterEvidence
    proposed_change: GenericProposedChange
    what_to_watch: list[str] = Field(min_length=1, max_length=8)


class GroundedThesisAssessment(StrictModel):
    assessment_id: str
    thesis_id: str
    base_version: int = Field(ge=1)
    event_id: str
    relation: EvidenceRelation
    materiality: Materiality
    reasoning: str
    claims: list[GroundedReasoningClaim] = Field(default_factory=list)
    driver_impacts: list[DriverEvidenceImpact] = Field(default_factory=list)
    counter_evidence: CounterEvidence
    proposed_change: GenericProposedChange
    what_to_watch: list[str]
    publish_status: PublishStatus
    validation_errors: list[str] = Field(default_factory=list)
    research_coverage_errors: list[str] = Field(default_factory=list)


class EvidenceRecord(StrictModel):
    evidence_id: str
    event_date: date
    information: str
    source: str
    source_text: str


class EvidenceTestBundle(StrictModel):
    schema_version: Literal["evidence-assessment-0.2"] = "evidence-assessment-0.2"
    assessment_run_id: str = Field(pattern=ARTIFACT_ID_PATTERN)
    thesis_state_id: str = Field(pattern=ARTIFACT_ID_PATTERN)
    packet_id: str = Field(pattern=ARTIFACT_ID_PATTERN)
    ticker: str
    base_version: int
    event_id: str
    assessments: list[GroundedThesisAssessment]
    quality: dict[str, int | float | str | bool]


class ThesisDecision(StrictModel):
    thesis_id: str
    assessment_id: str
    action: DecisionAction
    edited_statement: str | None = Field(default=None, max_length=2000)
    conviction: ThesisStatus | None = None

    @model_validator(mode="after")
    def edit_has_statement(self):
        if self.action == "edit" and not self.edited_statement:
            raise ValueError("edit requires edited_statement")
        if self.action != "edit" and self.edited_statement:
            raise ValueError("only edit may include edited_statement")
        if self.action in {"reject", "keep_unresolved"} and self.conviction is not None:
            raise ValueError("reject and keep_unresolved cannot change conviction")
        return self


class ApplyDecisionsRequest(StrictModel):
    thesis_state_id: str = Field(pattern=ARTIFACT_ID_PATTERN)
    assessment_run_id: str = Field(pattern=ARTIFACT_ID_PATTERN)
    decisions: list[ThesisDecision] = Field(min_length=1, max_length=5)


class ApplyDecisionsResult(StrictModel):
    changed: bool
    thesis_state_id: str = Field(pattern=ARTIFACT_ID_PATTERN)
    standing_thesis: GenericStandingThesis
    applied_thesis_ids: list[str] = Field(default_factory=list)
    retained_thesis_ids: list[str] = Field(default_factory=list)
