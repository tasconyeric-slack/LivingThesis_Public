from __future__ import annotations
from datetime import datetime, timezone
from typing import Literal
from pydantic import BaseModel, Field, HttpUrl

SourceClass = Literal["primary", "structured_vendor", "consensus", "sell_side", "news", "user_provided"]
EvidenceRole = Literal["reported_fact", "vendor_derived", "consensus", "interpretation", "news_event", "user_input"]
ValidationStatus = Literal["validated", "needs_review", "rejected"]
Direction = Literal["strengthened", "weakened", "mixed", "unchanged", "watch"]
Level = Literal["low", "medium", "high"]
FactKind = Literal[
    "financial_metric",
    "derived_financial_metric",
    "valuation_metric",
    "guidance",
    "operating_kpi",
    "qualitative_event",
    "risk_signal",
    "consensus_estimate",
    "news_event",
    "user_observation",
]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()

class SourceDoc(BaseModel):
    source_id: str
    provider: str = "legacy"
    source_class: SourceClass = "primary"
    source_type: str
    title: str
    publisher: str | None = None
    published_at: str | None = None
    retrieved_at: str = Field(default_factory=_utc_now)
    url: HttpUrl | None = None
    external_ref: str | None = None
    accession_no: str | None = None
    sha256: str | None = None
    authority_rank: int = Field(default=100, ge=1)
    license_scope: str | None = None
    provenance: dict[str, str | bool] = Field(default_factory=dict)

class Locator(BaseModel):
    kind: Literal["xbrl", "html_section", "pdf_page", "table", "text_anchor", "structured_observation"]
    section: str | None = None
    page: int | None = None
    table: str | None = None
    xbrl_tag: str | None = None
    context_ref: str | None = None
    anchor: str | None = None
    field: str | None = None
    record_id: str | None = None

class Evidence(BaseModel):
    evidence_id: str
    source_id: str
    role: EvidenceRole = "reported_fact"
    locator: Locator
    excerpt: str | None = None
    text_hash: str | None = None

class Fact(BaseModel):
    fact_id: str
    entity_id: str | None = None
    ticker: str | None = None
    fact_kind: FactKind
    metric_id: str
    label: str
    value: float | str | bool
    value_resolution: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    unit: str | None = None
    period_start: str | None = None
    period_end: str | None = None
    fiscal_period: str | None = None
    dimensions: dict[str, str] = Field(default_factory=dict)
    extraction_method: Literal[
        "xbrl",
        "deterministic_table",
        "deterministic_text",
        "llm_extract",
        "provider_api",
        "manual_input",
    ]
    evidence_ids: list[str]
    validation_status: ValidationStatus = "needs_review"
    validation_notes: list[str] = Field(default_factory=list)
    user_relevance: list[Literal["headline", "thesis_input", "risk", "watch_item"]] = Field(default_factory=list)

class RationaleClaim(BaseModel):
    text: str
    evidence_ids: list[str]

class ThesisDriverDelta(BaseModel):
    driver_id: Literal["D1", "D2", "D3", "D4", "D5", "D6"]
    name: str
    standing_thesis: str
    prior_state: str
    new_state: str
    direction: Direction
    materiality: Level
    confidence: Level
    rationale_claims: list[RationaleClaim]
    counter_evidence_ids: list[str] = Field(default_factory=list)
    what_to_watch: list[str]
    publish_status: ValidationStatus = "needs_review"

class Event(BaseModel):
    event_id: str
    ticker: str
    cik: str
    event_type: Literal["earnings"]
    fiscal_period: str
    period_end: str
    reported_at: str
    accession_no: str | None = None

class PipelineOutput(BaseModel):
    schema_version: Literal["0.3"] = "0.3"
    event: Event
    sources: list[SourceDoc]
    evidence: list[Evidence]
    facts: list[Fact]
    drivers: list[ThesisDriverDelta] = Field(default_factory=list)
    quality: dict[str, float | int | str | bool]


class EvidencePacket(BaseModel):
    schema_version: Literal["evidence-packet-0.2"] = "evidence-packet-0.2"
    packet_id: str
    ticker: str
    as_of: str
    research_question: str | None = None
    sources: list[SourceDoc]
    evidence: list[Evidence]
    facts: list[Fact]
    quality: dict
