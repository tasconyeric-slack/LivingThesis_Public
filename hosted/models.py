from typing import Annotated, Literal

from pydantic import Field, StringConstraints, field_validator, model_validator

from backend.src.living_thesis.mvp_models import (
    StrictModel, EvidenceInput, EvidenceRelation, GenericProposedChange,
    GenericStandingThesis, ThesisDecision, ThesisDriver,
)


Falsifier = Annotated[str, Field(min_length=3, max_length=800)]
OriginalText = Annotated[str, StringConstraints(strip_whitespace=False)]


class HostedEvidence(EvidenceInput):
    # Keep exact source bytes as decoded text; do not alter the private schema.
    source_text: OriginalText = Field(min_length=3, max_length=50000)

    @field_validator("source_text")
    @classmethod
    def meaningful_source(cls, value):
        if len(value.strip()) < 3:
            raise ValueError("Source text is empty")
        return value


class Driver(ThesisDriver):
    title: str = Field(min_length=3, max_length=80)
    falsifiers: list[Falsifier] = Field(min_length=1, max_length=5)
    what_to_watch: str = Field(min_length=3, max_length=600)


class Structure(StrictModel):
    statement: str = Field(min_length=10, max_length=2000)
    drivers: list[Driver] = Field(min_length=3, max_length=5)
    falsifiers: list[Falsifier] = Field(min_length=1, max_length=5)

    @model_validator(mode="after")
    def unique_drivers(self):
        ids = [d.driver_id for d in self.drivers]
        if len(ids) != len(set(ids)):
            raise ValueError("Duplicate drivers")
        return self


class Standing(Structure):
    ticker: str = Field(min_length=1, max_length=12)
    version: int = Field(default=1, ge=1, le=10000)
    # The thesis-level list aggregates every driver's falsifiers (5 drivers x 5), so a confirmed Standing
    # may hold more than the 5 a model may propose in Structure. The Owner-approved NVIDIA baseline has 8.
    # Keep in step with MAX_THESIS_FALSIFIERS in hosted/public/assets/session.js.
    falsifiers: list[Falsifier] = Field(min_length=1, max_length=25)

    @field_validator("ticker")
    @classmethod
    def normalize_ticker(cls, value):
        return GenericStandingThesis.normalize_ticker(value)


class DefineRequest(StrictModel):
    language: Literal["en", "zh"] = "en"
    ticker: str = Field(min_length=1, max_length=12)
    statement: OriginalText = Field(min_length=10, max_length=2000)

    @field_validator("statement")
    @classmethod
    def meaningful_statement(cls, value):
        if len(value.strip()) < 10:
            raise ValueError("Thesis text is empty")
        return value

    @field_validator("ticker")
    @classmethod
    def normalize_ticker(cls, value):
        return GenericStandingThesis.normalize_ticker(value)


class DriverImpact(StrictModel):
    driver_id: str = Field(min_length=1, max_length=40)
    relation: EvidenceRelation
    reasoning: str = Field(min_length=3, max_length=1000)
    exact_quote: OriginalText = Field(min_length=3, max_length=1600)


class ProposedChange(GenericProposedChange):
    # Hosted revisions must satisfy the Standing statement contract.
    revised_statement: str | None = Field(default=None, min_length=10, max_length=2000)


class Assessment(StrictModel):
    relevant: bool
    relation: EvidenceRelation
    reasoning: str = Field(min_length=3, max_length=1600)
    driver_impacts: list[DriverImpact] = Field(max_length=5)
    what_changed: list[str] = Field(min_length=1, max_length=5)
    proposed_change: ProposedChange
    what_to_watch: list[str] = Field(min_length=1, max_length=5)

    @field_validator("what_changed", "what_to_watch")
    @classmethod
    def bounded_strings(cls, values):
        if any(not 3 <= len(v.strip()) <= 800 for v in values):
            raise ValueError("Invalid explanation")
        return values

    @model_validator(mode="after")
    def coherent_result(self):
        ids = [i.driver_id for i in self.driver_impacts]
        if len(ids) != len(set(ids)):
            raise ValueError("Duplicate impacts")
        if not self.relevant and (ids or self.relation != "unresolved" or self.proposed_change.action != "no_change"):
            raise ValueError("Irrelevant evidence cannot change a thesis")
        if self.relation != "unresolved" and not ids:
            raise ValueError("Directional conclusions require driver evidence")
        if self.proposed_change.action == "revise" and self.relation == "unresolved":
            raise ValueError("Unresolved evidence cannot justify a revision")
        return self


class AssessRequest(StrictModel):
    language: Literal["en", "zh"] = "en"
    standing: Standing
    evidence: HostedEvidence


class DecisionRequest(StrictModel):
    standing: Standing
    assessment: Assessment
    receipt: str = Field(min_length=10, max_length=300)
    action: Literal["accept", "edit", "reject", "keep_unresolved"]
    edited_statement: str | None = Field(default=None, min_length=10, max_length=2000)

    @model_validator(mode="after")
    def decision_semantics(self):
        # Reuse the private engine's explicit human-decision contract.
        ThesisDecision(thesis_id="T1", assessment_id="A1", action=self.action,
                       edited_statement=self.edited_statement)
        return self
