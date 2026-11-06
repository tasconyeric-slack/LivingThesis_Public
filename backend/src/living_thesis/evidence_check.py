"""NVIDIA evidence check: one code path for historical replay and (later) manual Check for Updates.

Standing (approved) -> EDGAR acquisition at an as_of clock -> identity/dedupe/checkpoint ->
Stage 0 (deterministic) -> Stage 1 (light model triage over approved Watch Items) ->
selective research (deterministic sections, diff, XBRL) -> Stage 2 (bounded model assessment) ->
deterministic grounding gates -> What Changed -> explicit human decision -> Run Record.

Code owns identity, timestamps, filtering, diffs, numbers and validation. A model may only
classify and interpret, and nothing here changes a Standing Thesis without a human decision.
This module imports only the standard library, pydantic and httpx so the hosted function can
run its model stages.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import html
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_EVEN
from html.parser import HTMLParser
from pathlib import Path
from typing import Annotated, Any, Literal
from xml.etree import ElementTree
from zoneinfo import ZoneInfo

import httpx
from pydantic import Field, StringConstraints, ValidationError, field_validator, model_validator

from .mvp_models import EvidenceRelation, GenericProposedChange, Materiality, StrictModel, ThesisDecision

SCHEMA_RUN = "evidence-check-run-0.2"
RECORD_SCHEMAS = {"evidence-check-run-0.1", SCHEMA_RUN}
SCHEMA_CHECKPOINT = "evidence-check-checkpoint-0.1"
SCHEMA_STANDING = "check-standing-0.1"
EXTRACTOR_VERSION = "stdlib-text-0.1"
NVDA_CIK = "1045810"
TICKER = "NVDA"
PACKAGE = Path(__file__).resolve().parent
REPO = PACKAGE.parents[2]
PROMPTS = REPO / "backend" / "prompts"
STANDING_PROJECTION = PACKAGE / "nvda_check_standing.json"
BASELINE_ARTIFACT = REPO / "docs/approvals/nvda/2026-10-14-reconciled/nvda_product_baseline_v1.reconciled.json"
APPROVED_CONTENT_SHA256 = "634b812149c40bc129221b0ba451e210319fdc17847e1b80a8c91528777150ee"
APPROVAL_LEDGER = REPO / "docs/approvals/nvda/APPROVAL_LEDGER.json"
# Separately labelled historical T0 scenario Standings. Never Owner-approved; see validate_scenario_standing.
SCENARIO_STANDINGS = sorted(PACKAGE.glob("nvda_t0_scenario_*.json"))
LIVE_EVIDENCE_DIR = REPO / "docs/evidence/nvda"
DEFAULT_MODEL = "deepseek-flash"
MAX_FAILURE_ATTEMPTS = 3

# Stage 0 vocabulary. Ownership reports are filed by insiders/holders about their own trades;
# registration documents describe securities offerings. Neither carries issuer disclosure about
# the business. Everything else the issuer authors goes to Stage 1, because form type alone
# cannot tell whether it bears on a Watch Item. Unknown forms fail closed.
THIRD_PARTY_OWNERSHIP_FORMS = {"3", "3/A", "4", "4/A", "5", "5/A", "144", "144/A", "SC 13D", "SC 13D/A",
                               "SC 13G", "SC 13G/A", "SCHEDULE 13D", "SCHEDULE 13D/A", "SCHEDULE 13G",
                               "SCHEDULE 13G/A"}
REGISTRATION_FORMS = {"S-3", "S-3ASR", "S-4", "S-8", "S-8 POS", "424B2", "424B3", "424B5", "FWP", "POSASR"}
ISSUER_REPORT_FORMS = {"8-K", "8-K/A", "10-Q", "10-Q/A", "10-K", "10-K/A", "N-PX", "13F-HR", "13F-HR/A",
                       "DEF 14A", "DEFA14A", "ARS", "SD", "11-K"}
PERIODIC_FORMS = {"10-Q", "10-K"}
SKIP_FILES = re.compile(r"(^R\d+\.htm$|^\d{10}-\d{2}-\d{6}\.txt$|FilingSummary|MetaLinks|\.xsd$|_(lab|pre|cal|def|htm)\.xml$|"
                        r"-index|\.(css|js|jpg|jpeg|png|gif|zip|pdf|json)$)", re.I)
DOC_FILES = re.compile(r"\.(htm|html|xml|txt)$", re.I)

OriginalText = Annotated[str, StringConstraints(strip_whitespace=False)]


class CheckError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------- canonical helpers

def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def digest(value: Any) -> str:
    return sha256_text(canonical_json(value))


def utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


# ---------------------------------------------------------------- approved Standing

def baseline_content_sha256(artifact: dict) -> str:
    content = {k: v for k, v in artifact.items() if k != "provenance"}
    return digest(content)


def _en(value: Any) -> Any:
    return value.get("en") if isinstance(value, dict) and "en" in value else value


def project_check_standing(artifact: dict) -> dict:
    """English projection of the approved artifact. Every string is copied, never rewritten."""
    content_sha = baseline_content_sha256(artifact)
    if content_sha != APPROVED_CONTENT_SHA256:
        raise CheckError("baseline_hash_mismatch", "The baseline artifact is not the Owner-approved content.")
    families = artifact["families"]
    drivers = []
    for d in artifact["drivers"]:
        drivers.append({
            "driver_id": d["id"], "title": _en(d["title"]), "statement": _en(d["statement"]),
            "core_assumption": _en(d["coreAssumption"]), "importance": _en(d["importance"]),
            "what_to_watch": _en(d["whatToWatch"]), "source_ids": d["sourceIds"],
            "falsifiers": [{"id": f["id"], "condition": _en(f["condition"]), "review_quarters": f["reviewQuarters"],
                            "signal": f["signal"], "watch_item_ids": f["watchIds"]} for f in d["falsifiers"]],
            "watch_items": [{
                "id": w["id"], "research_need_id": w["researchNeedId"], "priority": w["priority"],
                "trigger_kind": w["triggerKind"], "title": _en(w["title"]), "question": _en(w["question"]),
                "observation_scope": _en(w["observationScope"]), "source_families": w["sourceFamilies"],
                # Same rule as monitorabilityMap: observable only through a known manual-intake family.
                "monitorable": any(families.get(f, {}).get("intake") == "manual" for f in w["sourceFamilies"]),
                "gap_reason": _en(w.get("gapReason")), "cannot_verify": _en(w.get("cannotVerify")),
            } for w in d["watchItems"]],
            "context_notes": [{
                "id": n["id"], "published_at": n["publishedAt"], "source_id": n["sourceId"],
                "citation": {"document": _en(n["citation"]["document"]), "url": n["citation"]["url"]},
                "parts": [{"kind": p["kind"], "text": _en(p["text"]), **({"quote": p["quote"]} if "quote" in p else {})}
                          for p in n["parts"]],
            } for n in artifact.get("contextNotes", []) if n["driverId"] == d["id"]],
        })
    hosted = {"ticker": TICKER, "version": artifact["version"], "statement": _en(artifact["statement"]),
              "falsifiers": [_en(f["condition"]) for d in artifact["drivers"] for f in d["falsifiers"]],
              "drivers": [{"driver_id": d["id"], "title": _en(d["title"]),
                           "statement": _en(d["statement"]) + " " + _en(d["coreAssumption"]),
                           "falsifiers": [_en(f["condition"]) for f in d["falsifiers"]],
                           "what_to_watch": _en(d["whatToWatch"])} for d in artifact["drivers"]]}
    return {"schema_version": SCHEMA_STANDING, "baseline_id": artifact["id"], "baseline_content_sha256": content_sha,
            "version": artifact["version"], "as_of": artifact["asOf"], "evidence_through": artifact["evidenceThrough"],
            "statement": _en(artifact["statement"]), "notices": [_en(n["text"]) for n in artifact["notices"]],
            "boundaries": [_en(b) for b in artifact["boundaries"]],
            "sources": [{"id": s["id"], "published_at": s["publishedAt"], "url": s["url"]} for s in artifact["sources"]],
            "drivers": drivers, "hosted_standing": hosted}


def load_standing() -> dict:
    """The committed projection. A test proves it equals the projection of the approved artifact."""
    standing = json.loads(STANDING_PROJECTION.read_text(encoding="utf-8"))
    if standing.get("baseline_content_sha256") != APPROVED_CONTENT_SHA256:
        raise CheckError("baseline_hash_mismatch", "Check standing is not bound to the approved baseline.")
    return standing


def standing_sha256(standing: dict) -> str:
    return digest(standing)


def watch_index(standing: dict) -> dict[str, dict]:
    return {w["id"]: {**w, "driver_id": d["driver_id"]} for d in standing["drivers"] for w in d["watch_items"]}


# ---------------------------------------------------------------- Standing provenance and effective date

SCENARIO_KIND = "historical_t0_scenario"


def standing_kind(standing: dict) -> str:
    """The approved projection carries no provenance block (adding one would change its hash)."""
    return (standing.get("provenance") or {}).get("kind", "owner_approved")


def validate_scenario_standing(standing: dict) -> dict:
    """A T0 scenario must say what it is, must not claim Owner approval and must hold nothing dated after T0."""
    p = standing.get("provenance") or {}
    problems = []
    if p.get("kind") != SCENARIO_KIND:
        problems.append("provenance.kind")
    if p.get("owner_approved") is not False:
        problems.append("provenance.owner_approved must be false")
    if not str(standing.get("baseline_id", "")).startswith("NVDA_T0_SCENARIO_"):
        problems.append("baseline_id must name a scenario")
    if standing.get("baseline_content_sha256") == APPROVED_CONTENT_SHA256:
        problems.append("a scenario must not carry the approved content hash as its own")
    if p.get("derived_from_content_sha256") != APPROVED_CONTENT_SHA256:
        problems.append("provenance.derived_from_content_sha256")
    for key in ("scenario_id", "effective_at", "authored_at", "label", "hindsight_note", "point_in_time_rule"):
        if not p.get(key):
            problems.append(f"provenance.{key}")
    if not problems:
        t0 = parse_utc(p["effective_at"])
        if date.fromisoformat(standing["evidence_through"]) >= t0.date():
            problems.append("evidence_through must precede T0")
        if any(date.fromisoformat(s["published_at"]) > date.fromisoformat(standing["evidence_through"])
               for s in standing.get("sources", [])):
            problems.append("a source is dated after evidence_through")
        if any(d.get("context_notes") or d.get("source_ids") for d in standing["drivers"]):
            problems.append("scenario drivers carry no dated context notes or sources")
    if problems:
        raise CheckError("invalid_scenario_standing", "Scenario Standing provenance is incomplete: " + "; ".join(problems))
    return standing


def load_scenario_standing(path: Path) -> dict:
    return validate_scenario_standing(json.loads(Path(path).read_text(encoding="utf-8")))


_KNOWN: dict[str, dict] | None = None


def known_standings() -> dict[str, dict]:
    """Standings a model stage may be bound to: the approved projection and committed scenarios.

    The server selects thesis text by the context's standing hash from this fixed set; a caller
    can never supply thesis text."""
    global _KNOWN
    if _KNOWN is None:
        standings = [load_standing(), *(load_scenario_standing(p) for p in SCENARIO_STANDINGS)]
        _KNOWN = {standing_sha256(s): s for s in standings}
    return _KNOWN


def standing_for_sha(sha: str) -> dict:
    standing = known_standings().get(sha)
    if standing is None:
        raise CheckError("stale_standing", "The context is not bound to a known Standing.")
    return standing


def approval_entry(standing: dict, ledger_path: Path = APPROVAL_LEDGER) -> dict:
    ledger = json.loads(Path(ledger_path).read_text(encoding="utf-8"))
    for entry in ledger["entries"]:
        approval = entry.get("approval") or {}
        if entry.get("status") == "owner_approved" and entry.get("content_sha256") == standing["baseline_content_sha256"] \
                and approval.get("content_sha256") == entry["content_sha256"] and approval.get("recorded_at"):
            return entry
    raise CheckError("standing_not_approved", "No Owner approval is recorded for this Standing's content.")


def standing_effective_at(standing: dict) -> datetime:
    """When this Standing began to exist as the belief being checked.

    Owner-approved: the recorded approval time in the ledger (a recording time, so never earlier
    than the approval itself). Scenario: its declared, labelled T0."""
    if standing_kind(standing) == SCENARIO_KIND:
        return parse_utc(validate_scenario_standing(standing)["provenance"]["effective_at"])
    if standing_kind(standing) != "owner_approved" or standing.get("baseline_content_sha256") != APPROVED_CONTENT_SHA256:
        raise CheckError("standing_not_approved", "Unknown Standing kind.")
    return parse_utc(approval_entry(standing)["approval"]["recorded_at"])


def standing_approval_label(standing: dict) -> str:
    if standing_kind(standing) == SCENARIO_KIND:
        p = standing["provenance"]
        return f"not_owner_approved ({SCENARIO_KIND} {p['scenario_id']}, T0 {p['effective_at']}, authored {p['authored_at']})"
    return f"owner_approved (content approval recorded {utc(standing_effective_at(standing))})"


def build_t0_scenario_standing(approved: dict, *, scenario_id: str, effective_at: str, evidence_through: str,
                               authored_at: str, label: str, rationale: str) -> dict:
    """A labelled lens for a historical T0: the approved Watch Item wording, minus everything dated.

    Statement, drivers, falsifiers and Watch Items are copied verbatim (generic, undated wording).
    Sources, source IDs, dated context notes and the current boundaries are removed because they
    describe documents and facts that did not exist at T0."""
    drivers = [{**{k: v for k, v in d.items() if k not in {"context_notes", "source_ids"}},
                "source_ids": [], "context_notes": []} for d in approved["drivers"]]
    hosted = json.loads(json.dumps(approved["hosted_standing"]))
    hosted["version"] = 1
    standing = {
        "schema_version": SCHEMA_STANDING, "baseline_id": f"NVDA_T0_SCENARIO_{scenario_id}",
        "baseline_content_sha256": None, "version": 1, "as_of": effective_at[:10], "evidence_through": evidence_through,
        "statement": approved["statement"],
        "notices": approved["notices"] + [
            f"Historical T0 scenario {scenario_id}: not the Owner's thesis and not an Owner-approved historical belief."],
        "boundaries": [
            "This is a labelled historical T0 scenario used to exercise the evidence check on an earlier real filing.",
            "Its wording was written after T0 and copied from the Owner-approved Watch Items; it is a test lens, "
            "not evidence of what anyone believed at T0.",
            "No dated source, context note or later fact is included; evidence at or before T0 only."],
        "sources": [], "drivers": drivers, "hosted_standing": hosted,
        "provenance": {"kind": SCENARIO_KIND, "owner_approved": False, "scenario_id": scenario_id, "label": label,
                       "effective_at": effective_at, "authored_at": authored_at,
                       "derived_from_content_sha256": APPROVED_CONTENT_SHA256,
                       "derivation": "statement, drivers, falsifiers and Watch Items copied verbatim from the approved "
                                     "projection; sources, source_ids, context_notes and boundaries removed",
                       "rationale": rationale,
                       "hindsight_note": "The Watch Item wording was authored in October 2026, after T0, and the "
                                         "assessing model may know later events. The scenario tests whether the "
                                         "cascade recognises direct Watch Item evidence; it is not a forecast test.",
                       "point_in_time_rule": "Every filing used is accepted by EDGAR at or before as_of; the scenario "
                                             "Standing contains no fact dated after evidence_through."}}
    standing["baseline_content_sha256"] = digest({k: v for k, v in standing.items() if k != "baseline_content_sha256"})
    return validate_scenario_standing(standing)


# ---------------------------------------------------------------- text extraction

class _TextParser(HTMLParser):
    BLOCK = {"p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "section", "td", "th"}
    SKIP = {"script", "style", "head", "title", "ix:header"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        elif tag in self.BLOCK:
            self.parts.append("\n" if tag not in {"td", "th"} else " ")

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag in self.BLOCK:
            self.parts.append("\n" if tag not in {"td", "th"} else " ")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def html_text(raw: bytes) -> str:
    parser = _TextParser()
    parser.feed(raw.decode("utf-8", errors="replace"))
    parser.close()
    return _tidy("".join(parser.parts))


def xml_text(raw: bytes) -> str:
    root = ElementTree.fromstring(raw)
    lines = []

    def walk(element, depth=0):
        name = element.tag.split("}")[-1]
        text = (element.text or "").strip()
        children = list(element)
        if children:
            lines.append(f"{name}:")
            for child in children:
                walk(child, depth + 1)
        elif text:
            lines.append(f"{name}: {text}")

    walk(root)
    return _tidy("\n".join(lines))


def _tidy(text: str) -> str:
    text = text.replace("\xa0", " ").replace("​", "").replace("\x00", "")  # JSONB cannot store NUL
    lines = [re.sub(r"[ \t\r\f\v]+", " ", line).strip() for line in text.split("\n")]
    return "\n".join(line for line in lines if line)


def document_text(filename: str, raw: bytes) -> str:
    if filename.lower().endswith(".xml"):
        return xml_text(raw)
    if filename.lower().endswith(".txt"):
        return _tidy(raw.decode("utf-8", errors="replace"))
    return html_text(raw)


def normalize_for_compare(text: str) -> str:
    text = text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"').replace("—", "-").replace("–", "-")
    return re.sub(r"\s+", " ", text).strip().lower()


SENTENCE = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"“(])")


def sentences(text: str) -> list[str]:
    out = []
    for paragraph in text.split("\n"):
        out.extend(s.strip() for s in SENTENCE.split(paragraph) if len(s.strip()) >= 25)
    return out


def form8k_items(text: str) -> list[dict]:
    """Item sections of an 8-K body, from each 'Item N.NN' line to the next one or SIGNATURE."""
    lines = text.split("\n")
    heads = [(i, m.group(1)) for i, line in enumerate(lines)
             if (m := re.match(r"^Item\s+(\d{1,2}\.\d{2})\b", line))]
    end_marker = next((i for i, line in enumerate(lines) if re.match(r"^SIGNATURES?\b", line)), len(lines))
    items = []
    for index, (start, number) in enumerate(heads):
        stop = heads[index + 1][0] if index + 1 < len(heads) else end_marker
        stop = min(stop, end_marker) if start < end_marker else stop
        body = "\n".join(lines[start:stop]).strip()
        if body:
            items.append({"item": number, "text": body})
    return items


# ---------------------------------------------------------------- EDGAR identity and time

@dataclass(frozen=True)
class FilingRef:
    accession: str
    form: str
    filing_date: str
    report_date: str
    primary_document: str
    items: str
    submissions_acceptance: str   # as returned by the EDGAR submissions API (recorded verbatim)

    @property
    def event_id(self) -> str:
        return f"edgar:{self.accession}"


def filings_from_submissions(submissions: dict) -> list[FilingRef]:
    recent = submissions["filings"]["recent"]
    count = len(recent["accessionNumber"])
    return [FilingRef(recent["accessionNumber"][i], recent["form"][i], recent["filingDate"][i],
                      recent.get("reportDate", [""] * count)[i] or "", recent["primaryDocument"][i],
                      recent.get("items", [""] * count)[i] or "", recent["acceptanceDateTime"][i])
            for i in range(count)]


def header_acceptance(header_text: str) -> str:
    """ACCEPTANCE-DATETIME from the filing header (EDGAR local time, US Eastern) as UTC."""
    match = re.search(r"ACCEPTANCE-DATETIME>\s*(\d{14})", header_text)
    if not match:
        raise CheckError("malformed_acquisition", "Filing header has no ACCEPTANCE-DATETIME.")
    local = datetime.strptime(match.group(1), "%Y%m%d%H%M%S").replace(tzinfo=ZoneInfo("America/New_York"))
    return utc(local)


def header_field(header_text: str, name: str) -> str | None:
    match = re.search(rf"{re.escape(name)}:\s*([^\n<]+)", header_text)
    return match.group(1).strip() if match else None


def available_by(ref: FilingRef, as_of: datetime, header_utc: str | None = None) -> bool:
    """Fail closed: every recorded acceptance reading must be at or before the clock."""
    readings = [parse_utc(ref.submissions_acceptance)] + ([parse_utc(header_utc)] if header_utc else [])
    return max(readings) <= as_of


# ---------------------------------------------------------------- checkpoint

def new_checkpoint(standing: dict) -> dict:
    return {"schema_version": SCHEMA_CHECKPOINT, "scope": f"{TICKER}:sec_edgar:cik{NVDA_CIK}",
            "standing_sha256": standing_sha256(standing),
            "initial_basis": {"rule": "edgar_filing_date_lte_evidence_through",
                              "evidence_through": standing["evidence_through"],
                              "note": "Derived starting point from the Standing's reading cutoff; not a monitored-through claim."},
            "reviewed_through": None, "processed": {}, "failures": {}, "history": []}


def load_checkpoint(path: Path, standing: dict) -> dict:
    if not path.exists():
        return new_checkpoint(standing)
    checkpoint = json.loads(path.read_text(encoding="utf-8"))
    if checkpoint.get("schema_version") != SCHEMA_CHECKPOINT or checkpoint.get("standing_sha256") != standing_sha256(standing):
        raise CheckError("checkpoint_scope_mismatch", "Checkpoint belongs to another Standing or schema; refusing to reuse it.")
    return checkpoint


def advance_checkpoint(checkpoint: dict, as_of: str, run_id: str, failed_event_ids: list[str]) -> dict:
    """reviewed_through only moves when every in-window event reached a terminal outcome."""
    updated = json.loads(json.dumps(checkpoint))
    previous = updated["reviewed_through"]
    if not failed_event_ids and (previous is None or parse_utc(as_of) > parse_utc(previous)):
        updated["reviewed_through"] = as_of
    updated["history"].append({"run_id": run_id, "as_of": as_of, "reviewed_through_before": previous,
                               "reviewed_through_after": updated["reviewed_through"],
                               "blocked_by": sorted(failed_event_ids)})
    return updated


# ---------------------------------------------------------------- model contracts

class TriageOutputV1(StrictModel):
    # Recorded contract of triage-context-0.1 (the 2026-10-18 live run), kept to verify that record.
    # Its JSON schema is part of the recorded prompt bytes: no docstring, and the recorded title.
    model_config = {**StrictModel.model_config, "title": "TriageOutput"}
    relevance: Literal["irrelevant", "relevant", "uncertain"]
    watch_item_ids: list[str] = Field(default_factory=list, max_length=13)
    rationale: str = Field(min_length=3, max_length=1200)
    evidence_quotes: list[OriginalText] = Field(default_factory=list, max_length=4)


TriageClass = Literal["watch_item_evidence", "driver_context", "irrelevant", "uncertain"]


class WatchItemAnswer(StrictModel):
    watch_item_id: str = Field(min_length=2, max_length=10)
    answers: str = Field(min_length=3, max_length=500)
    exact_quote: OriginalText = Field(min_length=3, max_length=1200)


class DriverContextNote(StrictModel):
    driver_id: str = Field(min_length=2, max_length=10)
    note: str = Field(min_length=3, max_length=500)
    exact_quote: OriginalText = Field(min_length=3, max_length=1200)


class TriageOutput(StrictModel):
    # triage-context-0.2: Watch Item evidence is kept apart from driver context, irrelevance and doubt.
    classification: TriageClass
    watch_item_answers: list[WatchItemAnswer] = Field(default_factory=list, max_length=6)
    uncertain_watch_item_ids: list[str] = Field(default_factory=list, max_length=6)
    driver_context: list[DriverContextNote] = Field(default_factory=list, max_length=5)
    rationale: str = Field(min_length=3, max_length=1200)


class ObservedFact(StrictModel):
    statement: str = Field(min_length=3, max_length=600)
    exact_quote: OriginalText = Field(min_length=3, max_length=1200)


class AssessedDriverImpact(StrictModel):
    driver_id: str = Field(min_length=1, max_length=40)
    relation: EvidenceRelation
    materiality: Materiality
    reasoning: str = Field(min_length=3, max_length=1200)
    exact_quote: OriginalText = Field(min_length=3, max_length=1600)


class EventProposedChange(GenericProposedChange):
    revised_statement: str | None = Field(default=None, min_length=10, max_length=2000)


class EventAssessment(StrictModel):
    """Extends the hosted Assessment contract; `hosted_assessment_view` returns a valid hosted Assessment."""
    relevant: bool
    relation: EvidenceRelation
    materiality: Materiality
    reasoning: str = Field(min_length=3, max_length=1600)
    observed_facts: list[ObservedFact] = Field(default_factory=list, max_length=8)
    driver_impacts: list[AssessedDriverImpact] = Field(default_factory=list, max_length=5)
    what_changed: list[str] = Field(min_length=1, max_length=5)
    counter_reading: str = Field(min_length=3, max_length=1200)
    uncertainties: list[str] = Field(min_length=1, max_length=6)
    proposed_change: EventProposedChange
    what_to_watch: list[str] = Field(min_length=1, max_length=5)

    @field_validator("what_changed", "what_to_watch", "uncertainties")
    @classmethod
    def bounded(cls, values):
        if any(not 3 <= len(v.strip()) <= 800 for v in values):
            raise ValueError("Invalid explanation")
        return values

    @model_validator(mode="after")
    def coherent(self):
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


PROPOSED_ACTION = {"revise": "propose_revision", "no_change": "reaffirm", "hold_unresolved": "keep_unresolved"}


def hosted_assessment_view(assessment: dict) -> dict:
    """Project onto hosted.models.Assessment (the durable workspace's assessment contract)."""
    return {"relevant": assessment["relevant"], "relation": assessment["relation"], "reasoning": assessment["reasoning"],
            "driver_impacts": [{k: i[k] for k in ("driver_id", "relation", "reasoning", "exact_quote")}
                               for i in assessment["driver_impacts"]],
            "what_changed": assessment["what_changed"], "proposed_change": assessment["proposed_change"],
            "what_to_watch": assessment["what_to_watch"]}


# ---------------------------------------------------------------- stage contexts (what the model sees)

class StageDocument(StrictModel):
    source_id: str = Field(min_length=3, max_length=200)
    filename: str = Field(min_length=1, max_length=200)
    text: OriginalText = Field(min_length=1, max_length=40000)


class StageEvent(StrictModel):
    event_id: str = Field(pattern=r"^edgar:\d{10}-\d{2}-\d{6}$")
    form: str = Field(min_length=1, max_length=20)
    filing_date: str = Field(min_length=10, max_length=10)
    accepted_at: str = Field(min_length=20, max_length=30)
    items: str = Field(default="", max_length=100)
    documents: list[StageDocument] = Field(min_length=1, max_length=6)

    @model_validator(mode="after")
    def bounded_total(self):
        if sum(len(d.text) for d in self.documents) > 40000:
            raise ValueError("event text too large")
        return self


IsoUtc = Annotated[str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$")]
Accession = Annotated[str, StringConstraints(pattern=r"^\d{10}-\d{2}-\d{6}$")]


class TriageNoteV1(StrictModel):
    relevance: Literal["relevant", "uncertain"]
    rationale: str = Field(min_length=3, max_length=1200)
    gap_watch_item_ids: list[str] = Field(default_factory=list, max_length=13)


class TriageNote(StrictModel):
    classification: Literal["watch_item_evidence", "uncertain"]
    rationale: str = Field(min_length=3, max_length=1200)
    answers: list[WatchItemAnswer] = Field(default_factory=list, max_length=6)
    uncertain_watch_item_ids: list[str] = Field(default_factory=list, max_length=6)
    gap_watch_item_ids: list[str] = Field(default_factory=list, max_length=13)


class SectionInfo(StrictModel):
    item: str = Field(min_length=1, max_length=20)
    chars: int = Field(ge=0, le=2_000_000)


class PriorFiling(StrictModel):
    accession: Accession
    form: Literal["10-Q", "10-K"]
    filing_date: str = Field(min_length=10, max_length=10)


class DiffSummary(StrictModel):
    method: str = Field(max_length=200)
    sentence_count: int = Field(ge=0, le=1000)
    new_sentence_count: int = Field(ge=0, le=1000)
    present_sentence_count: int = Field(ge=0, le=1000)
    new_sentences: list[Annotated[OriginalText, Field(max_length=2000)]] = Field(max_length=120)
    limits: str = Field(max_length=400)
    compared_with: list[PriorFiling] = Field(max_length=2)


class StatedAmount(StrictModel):
    quoted: str = Field(max_length=40)
    value_usd: str = Field(pattern=r"^\d{1,20}$")


class XbrlNote(StrictModel):
    tag: str = Field(max_length=120)
    basis: str = Field(max_length=20)
    status: str = Field(max_length=30)
    value: str | None = Field(default=None, pattern=r"^-?\d{1,20}(\.\d{1,10})?$")
    unit: str | None = Field(default=None, max_length=20)
    start: str | None = Field(default=None, max_length=10)
    end: str | None = Field(default=None, max_length=10)
    fiscal_year: int | None = None
    fiscal_period: str | None = Field(default=None, max_length=4)
    accession: Accession | None = None


class DerivedRatio(StrictModel):
    formula: str = Field(max_length=200)
    numerator_usd: str = Field(pattern=r"^\d{1,20}$")
    denominator_usd: str = Field(pattern=r"^\d{1,20}$")
    percent: str = Field(pattern=r"^\d{1,6}(\.\d)?$")


class DeterministicNote(StrictModel):
    sections: list[SectionInfo] = Field(max_length=20)
    risk_factor_diff: DiffSummary
    stated_amounts: list[StatedAmount] = Field(max_length=20)
    xbrl_observations: list[XbrlNote] = Field(max_length=10)
    derived: list[DerivedRatio] = Field(max_length=20)


class TriageContextV1(StrictModel):
    schema_version: Literal["triage-context-0.1"] = "triage-context-0.1"
    standing_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    as_of: IsoUtc
    event: StageEvent


class AssessContextV1(StrictModel):
    schema_version: Literal["assess-context-0.1"] = "assess-context-0.1"
    standing_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    as_of: IsoUtc
    event: StageEvent
    driver_ids: list[str] = Field(min_length=1, max_length=5)
    watch_item_ids: list[str] = Field(min_length=1, max_length=13)
    research_need_ids: list[str] = Field(min_length=1, max_length=13)
    triage: TriageNoteV1
    deterministic: DeterministicNote


class TriageContext(TriageContextV1):
    schema_version: Literal["triage-context-0.2"] = "triage-context-0.2"


class AssessContext(AssessContextV1):
    schema_version: Literal["assess-context-0.2"] = "assess-context-0.2"
    triage: TriageNote


@dataclass(frozen=True)
class StageSpec:
    stage: str
    context_model: type
    prompt_file: str
    max_tokens: int
    output_model: type


# Every contract a Run Record may cite. Prompts are versioned files: a recorded prompt is never edited.
STAGE_SPECS = {
    "triage-context-0.1": StageSpec("triage", TriageContextV1, "evidence_check_triage.md", 1200, TriageOutputV1),
    "assess-context-0.1": StageSpec("assess", AssessContextV1, "evidence_check_assess.md", 3500, EventAssessment),
    "triage-context-0.2": StageSpec("triage", TriageContext, "evidence_check_triage_v2.md", 1500, TriageOutput),
    "assess-context-0.2": StageSpec("assess", AssessContext, "evidence_check_assess_v2.md", 3500, EventAssessment),
}
CURRENT_STAGES = {"triage": "triage-context-0.2", "assess": "assess-context-0.2"}
STAGES = {stage: STAGE_SPECS[version] for stage, version in CURRENT_STAGES.items()}


def prompt_text(stage: str, version: str | None = None) -> str:
    spec = STAGE_SPECS[version] if version else STAGES[stage]
    return (PROMPTS / spec.prompt_file).read_text(encoding="utf-8")


def _standing_for_stage(standing: dict, stage: str, context: dict) -> dict:
    """Thesis text comes from the approved projection, never from the caller."""
    if stage == "triage":
        return {"statement": standing["statement"], "drivers": [{
            "driver_id": d["driver_id"], "title": d["title"], "statement": d["statement"],
            "watch_items": [{k: w[k] for k in ("id", "title", "question", "observation_scope", "monitorable")}
                            for w in d["watch_items"]]} for d in standing["drivers"]]}
    wanted = set(context["driver_ids"])
    watch = set(context["watch_item_ids"])
    return {"statement": standing["statement"], "notices": standing["notices"], "drivers": [{
        **{k: d[k] for k in ("driver_id", "title", "statement", "core_assumption", "importance", "what_to_watch",
                             "falsifiers", "context_notes")},
        "watch_items": [w for w in d["watch_items"] if w["id"] in watch]}
        for d in standing["drivers"] if d["driver_id"] in wanted]}


def build_model_request(stage: str, context: dict, standing: dict | None = None) -> dict:
    """The exact model request for a stage. Local and server execution call this same function.

    The contract version comes from the context's schema_version (current version if absent), so a
    recorded request can be rebuilt byte for byte. Without an explicit Standing, the thesis text is
    chosen from the committed Standings by the context's hash, never taken from the caller."""
    if stage not in STAGES or not isinstance(context, dict):
        raise CheckError("invalid_stage", "Unknown model stage.")
    version = context.get("schema_version") or CURRENT_STAGES[stage]
    spec = STAGE_SPECS.get(version)
    if spec is None or spec.stage != stage:
        raise CheckError("invalid_stage", "Unknown stage contract.")
    model, max_tokens = spec.context_model, spec.max_tokens
    parsed = model.model_validate(context).model_dump(mode="json")
    standing = standing or standing_for_sha(parsed["standing_sha256"])
    if parsed["standing_sha256"] != standing_sha256(standing):
        raise CheckError("stale_standing", "The context is not bound to the approved Standing.")
    index = watch_index(standing)
    if stage == "assess":
        drivers = {d["driver_id"] for d in standing["drivers"]}
        if not set(parsed["driver_ids"]) <= drivers or not set(parsed["watch_item_ids"]) <= set(index):
            raise CheckError("invalid_scope", "Scope names IDs outside the approved Standing.")
        if {index[w]["driver_id"] for w in parsed["watch_item_ids"]} != set(parsed["driver_ids"]) or \
                {index[w]["research_need_id"] for w in parsed["watch_item_ids"]} != set(parsed["research_need_ids"]):
            raise CheckError("invalid_scope", "Scope must be the Watch Item -> Need -> Driver closure.")
    system = prompt_text(stage, version) + "\nReturn strict JSON matching this schema:\n" + json.dumps(
        spec.output_model.model_json_schema(), sort_keys=True)
    user = canonical_json({**parsed, "standing": _standing_for_stage(standing, stage, parsed)})
    return {"stage": stage, "version": version, "system": system, "user": user, "max_tokens": max_tokens,
            "prompt_sha256": sha256_text(system), "context_sha256": sha256_text(user)}


# ---------------------------------------------------------------- model transports

class DeepSeekTransport:
    """Same request shape as hosted.service.model_json, plus observed model/usage metadata."""
    executor = "local_deepseek"

    def __init__(self, api_key: str, model: str = DEFAULT_MODEL, timeout: float = 45.0,
                 transport: httpx.BaseTransport | None = None):
        if not api_key:
            raise CheckError("model_unavailable", "DEEPSEEK_API_KEY is not configured.")
        self._key, self.model, self.timeout, self._transport = api_key, model, timeout, transport

    def run(self, stage: str, context: dict, standing: dict | None = None) -> dict:
        request = build_model_request(stage, context, standing)
        body = {"model": self.model, "thinking": {"type": "disabled"}, "response_format": {"type": "json_object"},
                "max_tokens": request["max_tokens"], "stream": False,
                "messages": [{"role": "system", "content": request["system"]},
                             {"role": "user", "content": request["user"]}]}
        started = time.perf_counter()
        try:
            with httpx.Client(timeout=httpx.Timeout(self.timeout, connect=8), trust_env=False,
                              transport=self._transport) as client:
                response = client.post("https://api.deepseek.com/chat/completions",
                                       headers={"Authorization": "Bearer " + self._key}, json=body)
        except httpx.TimeoutException:
            raise CheckError("model_timeout", "Model call timed out.") from None
        except httpx.HTTPError:
            raise CheckError("provider_unavailable", "Model provider unavailable.") from None
        latency = int((time.perf_counter() - started) * 1000)
        if response.status_code >= 400:
            raise CheckError("provider_unavailable", f"Model provider returned HTTP {response.status_code}.")
        try:
            payload = response.json()
            choice = payload["choices"][0]
            content = choice["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError):
            raise CheckError("invalid_model_output", "Model response had no content.") from None
        if choice.get("finish_reason") != "stop":
            raise CheckError("invalid_model_output", "Model output was incomplete.")
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else None
        return {"content": content if isinstance(content, str) else "",
                "meta": {"executor": self.executor, "requested_model": self.model,
                         "response_model": payload.get("model"), "provider_response_id": payload.get("id"),
                         "finish_reason": choice.get("finish_reason"),
                         "usage": {k: v for k, v in (usage or {}).items() if isinstance(v, (int, float))} or None,
                         "latency_ms": latency},
                "prompt_sha256": request["prompt_sha256"], "context_sha256": request["context_sha256"]}


class RemoteTransport:
    """Runs a stage through a deployed hosted function that holds the key server-side."""
    executor = "hosted_function"

    def __init__(self, base_url: str, token: str | None = None, timeout: float = 75.0,
                 transport: httpx.BaseTransport | None = None):
        self.base_url = base_url.rstrip("/")
        # Preview access token: read from the environment, sent only as a header, never recorded.
        self._token = token if token is not None else os.environ.get("EVIDENCE_CHECK_TOKEN", "")
        if not self._token:
            raise CheckError("executor_unauthorized", "EVIDENCE_CHECK_TOKEN is not configured for the hosted executor.")
        self.timeout, self._transport = timeout, transport
        self.build_info: dict | None = None

    def describe(self) -> dict:
        try:
            with httpx.Client(timeout=20, transport=self._transport) as client:
                info = client.get(self.base_url + "/assets/build-info.json").json()
                health = client.get(self.base_url + "/api/health").json()
        except (httpx.HTTPError, ValueError):
            raise CheckError("executor_unavailable", "The hosted executor could not be described.") from None
        self.build_info = {"revision": info.get("revision"), "baseline_content_sha256": info.get("baselineContentSha256"),
                           "custom_available": health.get("custom_available")}
        return self.build_info

    def run(self, stage: str, context: dict, standing: dict | None = None) -> dict:
        local = build_model_request(stage, context, standing)
        started = time.perf_counter()
        try:
            with httpx.Client(timeout=self.timeout, transport=self._transport) as client:
                response = client.post(self.base_url + "/api/evidence-check/model", json={"stage": stage, "context": context},
                                       headers={"Authorization": "Bearer " + self._token})
        except httpx.HTTPError:
            raise CheckError("executor_unavailable", "Hosted executor request failed.") from None
        try:
            payload = response.json()
        except ValueError:
            raise CheckError("executor_unavailable", f"Hosted executor returned HTTP {response.status_code}.") from None
        if response.status_code >= 400:
            code = (payload.get("error") or {}).get("code", "executor_error") if isinstance(payload, dict) else "executor_error"
            raise CheckError(code, f"Hosted executor returned HTTP {response.status_code} ({code}).")
        # The server must have sent the model exactly the request this code builds.
        if payload.get("prompt_sha256") != local["prompt_sha256"] or payload.get("context_sha256") != local["context_sha256"]:
            raise CheckError("executor_request_mismatch", "Hosted executor built a different model request.")
        meta = dict(payload.get("meta") or {})
        if meta.get("finish_reason") != "stop":
            raise CheckError("invalid_model_output", "Hosted executor returned an incomplete model output.")
        # The executor's address is not recorded; its build revision identifies the code that ran.
        meta.update(executor=self.executor, executor_build=self.build_info,
                    round_trip_ms=int((time.perf_counter() - started) * 1000))
        return {"content": payload.get("content", ""), "meta": meta,
                "prompt_sha256": local["prompt_sha256"], "context_sha256": local["context_sha256"]}


def run_model_stage_server(stage: str, context: dict, api_key: str, transport: httpx.BaseTransport | None = None) -> dict:
    """Server half of RemoteTransport: validate, build the same request, call the provider.

    Only the current contracts run here; recorded older contracts are for offline verification."""
    if not isinstance(context, dict) or context.get("schema_version") != CURRENT_STAGES.get(stage):
        raise CheckError("invalid_stage", "Only the current stage contract runs on the hosted executor.")
    return DeepSeekTransport(api_key, transport=transport).run(stage, context)


ROUTE_TOKEN_HEADER = "Authorization"


def route_token_valid(header_value: str | None, verifier_sha256: str | None) -> bool:
    """Preview route access: SHA-256 of the presented bearer token must equal the configured verifier.

    Only the verifier (a hash) is configured or committed; the token itself is never stored."""
    if not verifier_sha256 or not re.fullmatch(r"[0-9a-f]{64}", verifier_sha256.strip().lower()):
        return False
    if not header_value or not header_value.startswith("Bearer "):
        return False
    token = header_value[len("Bearer "):].strip()
    if len(token) < 32:
        return False
    return hmac.compare_digest(sha256_text(token), verifier_sha256.strip().lower())


# ---------------------------------------------------------------- deterministic validation

NUMBER = re.compile(r"\d[\d,]*(?:\.\d+)?")


def _numbers(text: str) -> set[str]:
    return {n.replace(",", "").rstrip(".") for n in NUMBER.findall(text)}


MIN_QUOTE_CHARS, MIN_QUOTE_WORDS = 20, 4
HEX_OR_ACCESSION = re.compile(r"\b[0-9a-f]{64}\b|\b\d{10}-\d{2}-\d{6}\b")


def _substantive(quote: str) -> bool:
    return len(quote.strip()) >= MIN_QUOTE_CHARS and len(quote.split()) >= MIN_QUOTE_WORDS


def _bind_quote(quote: str, documents: list[dict]) -> dict | None:
    """Bind a quote to the text the model was shown (`text`); offsets refer to the full stored text."""
    if not quote or not quote.strip():
        return None
    for doc in documents:
        if quote in doc["text"]:
            full = doc.get("full_text", doc["text"])
            return {"source_id": doc["source_id"], "offset": full.find(quote), "length": len(quote),
                    "text_sha256": doc["text_sha256"]}
    return None


def allowed_numbers(user_content: str) -> set[str]:
    """Numbers the model was given, excluding digests, accession numbers and model-written triage text."""
    data = json.loads(user_content)
    if isinstance(data.get("triage"), dict):
        data["triage"] = {**data["triage"], "rationale": "",
                          "answers": [{**a, "answers": ""} for a in data["triage"].get("answers", [])]}
    data.pop("standing_sha256", None)
    return _numbers(HEX_OR_ACCESSION.sub(" ", canonical_json(data)))


def validate_triage_v1(raw: str, standing: dict, documents: list[dict],
                       allowed: set[str] | None = None) -> tuple[dict | None, list[str], list[dict]]:
    """Gates of the recorded triage-context-0.1 contract (kept to re-verify that record)."""
    errors: list[str] = []
    try:
        triage = TriageOutputV1.model_validate_json(raw)
    except (ValidationError, ValueError):
        return None, ["triage_schema_invalid"], []
    known = watch_index(standing)
    bad = [w for w in triage.watch_item_ids if w not in known]
    errors += [f"unknown_watch_item:{w}" for w in bad]
    if len(set(triage.watch_item_ids)) != len(triage.watch_item_ids):
        errors.append("duplicate_watch_item")
    if triage.relevance == "irrelevant" and triage.watch_item_ids:
        errors.append("irrelevant_with_watch_items")
    if triage.relevance != "irrelevant" and not triage.watch_item_ids:
        errors.append("relevance_without_watch_items")
    if triage.relevance == "relevant" and not triage.evidence_quotes:
        errors.append("relevant_without_quote")
    bindings = []
    for quote in triage.evidence_quotes:
        bound = _bind_quote(quote, documents)
        if not _substantive(quote):
            errors.append("triage_quote_too_short")
        elif bound is None:
            errors.append("triage_quote_not_verbatim")
        else:
            bindings.append({"exact_quote": quote, **bound})
    if allowed is None:
        allowed = _numbers(" ".join(d["text"] for d in documents)) | _numbers(" ".join(known))
    errors += [f"unsupported_number:{n}" for n in sorted(_numbers(triage.rationale) - allowed)]
    return triage.model_dump(mode="json"), errors, bindings


# Watch Item scope guards: a necessary (never sufficient) condition for "this passage answers this
# Watch Item". Each group is a list of word stems copied from that Watch Item's own approved
# question or observation scope (a test proves it); a quote must contain a stem from EVERY group.
# This narrows what may count as an answer; it never widens or rewrites a Watch Item. A claimed
# answer that fails it is demoted to driver context and the demotion is recorded for review.
WATCH_SCOPE_GUARDS: dict[str, tuple[tuple[str, ...], ...]] = {
    "W1.1": (("data center",), ("growth", "revenue", "guidance", "demand", "deployment")),
    "W2.1": (("production", "deployment", "schedule", "supply", "transition"),),
    "W3.1": (("adopt", "migrat", "pric", "competit"),),
    "W4.1": (("margin",),),
    # China (the market) AND an NVIDIA sales/licensing term: "models originated in China" is not "China sales".
    "W5.1": (("china",), ("sale", "revenue", "licens", "permitted", "exposure")),
}
SAFE_HARBOR_HEADING = re.compile(r"^[ \t]*(?:cautionary (?:note|statement)s?[^\n]*)?forward[- ]looking statements\.?[ \t]*$",
                                 re.I | re.M)
NEXT_SECTION = re.compile(r"^[ \t]*(?:item\s+\d+[a-z]?(?:\.\d+)?\.|part\s+[ivx]+\b|signatures?\b)", re.I | re.M)


def _has_stem(text: str, stem: str) -> bool:
    return re.search(r"\b" + re.escape(stem), text, re.I) is not None


def scope_guard_failures(watch_item_id: str, quote: str, paragraph: str | None = None) -> list[str]:
    """Groups of the Watch Item's guard that are not satisfied (empty list = passes).

    Every group must be satisfied within the quote's own paragraph (a sentence may carry "the
    licence requirement" while its paragraph names China), and the quote itself must carry at
    least one guard stem, so a passage cannot borrow all of its relevance from its neighbours."""
    groups = WATCH_SCOPE_GUARDS.get(watch_item_id)
    if groups is None:
        return ["no_guard_defined"]
    scope = paragraph if paragraph and quote in paragraph else quote
    missing = ["|".join(g) for g in groups if not any(_has_stem(scope, stem) for stem in g)]
    if not missing and not any(_has_stem(quote, stem) for g in groups for stem in g):
        missing.append("quote_carries_no_guard_term")
    return missing


def enclosing_paragraph(binding: dict, documents: list[dict]) -> str | None:
    doc = next((d for d in documents if d["source_id"] == binding["source_id"]), None)
    if doc is None or binding["offset"] < 0:
        return None
    text = doc.get("full_text", doc["text"])
    start = text.rfind("\n", 0, binding["offset"]) + 1
    end = text.find("\n", binding["offset"] + binding["length"])
    return text[start:end if end >= 0 else len(text)]


SAFE_HARBOR_LINE = re.compile(r"forward[- ]looking statements?|could cause (?:actual )?results to (?:differ|be materially)", re.I)


def safe_harbor_spans(text: str) -> list[tuple[int, int]]:
    """Forward-looking-statement safe-harbor text: a headed section up to the next section heading,
    and any line that is itself safe-harbor language (8-Ks often carry it without a heading)."""
    spans = []
    for match in SAFE_HARBOR_HEADING.finditer(text):
        nxt = NEXT_SECTION.search(text, match.end())
        spans.append((match.start(), nxt.start() if nxt else len(text)))
    offset = 0
    for line in text.splitlines(keepends=True):
        if SAFE_HARBOR_LINE.search(line):
            spans.append((offset, offset + len(line)))
        offset += len(line)
    return spans


def _in_safe_harbor(binding: dict, documents: list[dict]) -> bool:
    doc = next((d for d in documents if d["source_id"] == binding["source_id"]), None)
    if doc is None or binding["offset"] < 0:
        return False
    return any(a <= binding["offset"] < b for a, b in safe_harbor_spans(doc.get("full_text", doc["text"])))


def gap_watch_items(standing: dict, watch_item_ids: list[str]) -> list[str]:
    """Code, not the model, names the monitoring gaps: unobservable Watch Items sharing a falsifier."""
    index = watch_index(standing)
    gaps: list[str] = []
    for d in standing["drivers"]:
        for f in d["falsifiers"]:
            if set(f["watch_item_ids"]) & set(watch_item_ids):
                gaps += [w for w in f["watch_item_ids"] if not index[w]["monitorable"] and w not in gaps]
    return gaps


def validate_triage(raw: str, standing: dict, documents: list[dict],
                    allowed: set[str] | None = None) -> tuple[dict | None, list[str], list[dict], dict | None]:
    """triage-context-0.2 gates. Returns (model output, errors, quote bindings, effective classification).

    Errors reject the output (it is retried and holds the checkpoint). The scope guard and the
    safe-harbor rule do not reject: they demote a claimed Watch Item answer to driver context, and
    the demotion is recorded so a person can see what the model claimed and why it did not count."""
    errors: list[str] = []
    try:
        triage = TriageOutput.model_validate_json(raw)
    except (ValidationError, ValueError):
        return None, ["triage_schema_invalid"], [], None
    known = watch_index(standing)
    drivers = {d["driver_id"] for d in standing["drivers"]}
    answered = [a.watch_item_id for a in triage.watch_item_answers]
    for w in answered + triage.uncertain_watch_item_ids:
        if w not in known:
            errors.append(f"unknown_watch_item:{w}")
        elif not known[w]["monitorable"]:
            errors.append(f"watch_item_not_observable:{w}")
    errors += [f"unknown_driver:{c.driver_id}" for c in triage.driver_context if c.driver_id not in drivers]
    if len(set(answered)) != len(answered) or len(set(triage.uncertain_watch_item_ids)) != len(triage.uncertain_watch_item_ids) \
            or set(answered) & set(triage.uncertain_watch_item_ids):
        errors.append("duplicate_watch_item")
    if len({c.driver_id for c in triage.driver_context}) != len(triage.driver_context):
        errors.append("duplicate_driver_context")
    c = triage.classification
    shape = {"watch_item_evidence": bool(answered) and not triage.uncertain_watch_item_ids,
             "driver_context": not answered and not triage.uncertain_watch_item_ids and bool(triage.driver_context),
             "irrelevant": not answered and not triage.uncertain_watch_item_ids and not triage.driver_context,
             "uncertain": not answered and bool(triage.uncertain_watch_item_ids)}
    if not shape[c]:
        errors.append(f"classification_incoherent:{c}")
    bindings, bound = [], {}
    quoted = [("answer", a.watch_item_id, a.exact_quote) for a in triage.watch_item_answers] + \
             [("driver_context", n.driver_id, n.exact_quote) for n in triage.driver_context]
    for role, ref, quote in quoted:
        binding = _bind_quote(quote, documents)
        if not _substantive(quote):
            errors.append(f"triage_quote_too_short:{ref}")
        elif binding is None:
            errors.append(f"triage_quote_not_verbatim:{ref}")
        else:
            bindings.append({"role": role, "ref": ref, "exact_quote": quote, **binding})
            bound[(role, ref)] = binding
    if allowed is None:
        allowed = _numbers(" ".join(d["text"] for d in documents)) | _numbers(" ".join(known))
    free = [triage.rationale, *(a.answers for a in triage.watch_item_answers), *(n.note for n in triage.driver_context)]
    errors += [f"unsupported_number:{n}" for n in sorted(set().union(*(_numbers(t) for t in free)) - allowed)]
    data = triage.model_dump(mode="json")
    if errors:
        return data, errors, bindings, None
    kept, demoted = [], []
    for a in data["watch_item_answers"]:
        binding = bound[("answer", a["watch_item_id"])]
        failures = scope_guard_failures(a["watch_item_id"], a["exact_quote"], enclosing_paragraph(binding, documents))
        reasons = [f"scope_guard_missing:{g}" for g in failures]
        if _in_safe_harbor(binding, documents):
            reasons.append("safe_harbor_boilerplate")
        if reasons:
            demoted.append({**a, "driver_id": known[a["watch_item_id"]]["driver_id"], "reasons": reasons})
        else:
            kept.append(a)
    context = data["driver_context"] + [
        {"driver_id": d["driver_id"], "note": f"Demoted from a claimed {d['watch_item_id']} answer: " + "; ".join(d["reasons"]),
         "exact_quote": d["exact_quote"]} for d in demoted
        if d["driver_id"] not in {n["driver_id"] for n in data["driver_context"]}]
    if kept:
        effective_class = "watch_item_evidence"
    elif data["uncertain_watch_item_ids"]:
        effective_class = "uncertain"
    elif context:
        effective_class = "driver_context"
    else:
        effective_class = "irrelevant"
    effective = {"classification": effective_class, "watch_item_answers": kept,
                 "uncertain_watch_item_ids": data["uncertain_watch_item_ids"], "driver_context": context,
                 "demoted_answers": demoted,
                 "gap_watch_item_ids": gap_watch_items(standing, [a["watch_item_id"] for a in kept] +
                                                       data["uncertain_watch_item_ids"]),
                 "changed_by_code": bool(demoted)}
    return data, errors, bindings, effective


def validate_assessment(raw: str, context_user: str, documents: list[dict], scope_drivers: set[str],
                        triage_relevance: str) -> tuple[dict | None, list[str], list[dict]]:
    errors: list[str] = []
    try:
        assessment = EventAssessment.model_validate_json(raw)
    except (ValidationError, ValueError):
        return None, ["assessment_schema_invalid"], []
    data = assessment.model_dump(mode="json")
    evidence = []
    for index, impact in enumerate(data["driver_impacts"]):
        if impact["driver_id"] not in scope_drivers:
            errors.append(f"driver_outside_research_scope:{impact['driver_id']}")
        bound = _bind_quote(impact["exact_quote"], documents)
        if not _substantive(impact["exact_quote"]):
            errors.append(f"driver_quote_too_short:{impact['driver_id']}")
        elif bound is None:
            errors.append(f"driver_quote_not_verbatim:{impact['driver_id']}")
        else:
            evidence.append({"evidence_id": f"EV-I{index + 1}", "role": "driver_impact", "driver_id": impact["driver_id"],
                             "exact_quote": impact["exact_quote"], **bound})
    for index, fact in enumerate(data["observed_facts"]):
        bound = _bind_quote(fact["exact_quote"], documents)
        if not _substantive(fact["exact_quote"]):
            errors.append(f"observed_fact_quote_too_short:{index + 1}")
        elif bound is None:
            errors.append(f"observed_fact_quote_not_verbatim:{index + 1}")
        else:
            evidence.append({"evidence_id": f"EV-F{index + 1}", "role": "observed_fact",
                             "exact_quote": fact["exact_quote"], **bound})
    allowed = allowed_numbers(context_user)
    free_text = [data["reasoning"], data["counter_reading"], *data["what_changed"], *data["uncertainties"],
                 *data["what_to_watch"], data["proposed_change"]["reason"], data["proposed_change"]["revised_statement"] or "",
                 *(i["reasoning"] for i in data["driver_impacts"]), *(f["statement"] for f in data["observed_facts"])]
    for number in sorted(set().union(*(_numbers(t) for t in free_text)) - allowed):
        errors.append(f"unsupported_number:{number}")
    if triage_relevance == "uncertain" and data["proposed_change"]["action"] == "revise":
        errors.append("uncertain_event_cannot_propose_revision")
    return data, errors, evidence


# ---------------------------------------------------------------- research (deterministic)

def risk_factor_diff(section_text: str, comparisons: list[dict]) -> dict:
    """Which sentences of the event section do not appear in the prior periodic reports."""
    corpus = {c["accession"]: normalize_for_compare(c["text"]) for c in comparisons}
    rows = []
    for sentence in sentences(section_text)[:120]:
        key = normalize_for_compare(sentence)
        found = sorted(a for a, text in corpus.items() if key in text)
        rows.append({"sentence": sentence, "present_in": found})
    new = [r["sentence"] for r in rows if not r["present_in"]]
    return {"method": "normalized sentence containment against full prior 10-Q/10-K text",
            "compared_with": [{k: c[k] for k in ("accession", "form", "filing_date", "url", "sha256", "text_sha256")}
                              for c in comparisons],
            "sentence_count": len(rows), "new_sentence_count": len(new),
            "present_sentence_count": len(rows) - len(new), "new_sentences": new,
            "limits": "Exact containment after whitespace/quote normalization. Rephrased prior risks count as new; "
                      "this is a deterministic text difference, not a judgment of materiality."}


AMOUNT = re.compile(r"\$\s?(\d+(?:\.\d+)?)\s+(billion|million)")


def stated_amounts(section_text: str) -> list[dict]:
    out = []
    for sentence in sentences(section_text):
        for match in AMOUNT.finditer(sentence):
            scale = Decimal(1_000_000_000) if match.group(2) == "billion" else Decimal(1_000_000)
            out.append({"quoted": match.group(0), "value_usd": str((Decimal(match.group(1)) * scale).quantize(Decimal(1))), "sentence": sentence})
    return out


def xbrl_context(companyfacts: dict, periodic: FilingRef | None, as_of: datetime) -> dict:
    from .xbrl import observations_for_accession, select_current, AmbiguousObservation
    if periodic is None:
        return {"status": "no_periodic_report_before_event", "observations": []}
    selected = []
    for tag, basis in (("Revenues", "quarter"), ("Revenues", "half_year_ytd"),
                       ("CashAndCashEquivalentsAtCarryingValue", "instant")):
        observations = observations_for_accession(companyfacts, periodic.accession, tag, period_end=periodic.report_date or None)
        try:
            hit = select_current(observations, basis)
        except AmbiguousObservation:
            selected.append({"tag": tag, "basis": basis, "status": "ambiguous"})
            continue
        if hit is None:
            selected.append({"tag": tag, "basis": basis, "status": "unresolved"})
        elif hit.filed and date.fromisoformat(hit.filed) > as_of.date():
            selected.append({"tag": tag, "basis": basis, "status": "filed_after_as_of"})
        else:
            selected.append({"status": "resolved", **hit.as_dict()})
    return {"status": "ok", "accession": periodic.accession, "form": periodic.form, "report_date": periodic.report_date,
            "observations": selected}


def derived_ratios(amounts: list[dict], xbrl: dict) -> list[dict]:
    quarter = next((o for o in xbrl.get("observations", []) if o.get("status") == "resolved"
                    and o.get("tag") == "Revenues" and o.get("basis") == "quarter"), None)
    if not quarter:
        return []
    out = []
    for amount in amounts:
        ratio = (Decimal(amount["value_usd"]) / Decimal(quarter["value"]) * 100).quantize(Decimal("0.1"), ROUND_HALF_EVEN)
        out.append({"formula": f"{amount['quoted']} / Revenues ({quarter['fiscal_period']} FY{quarter['fiscal_year']}, quarter)",
                    "numerator_usd": amount["value_usd"], "denominator_usd": quarter["value"], "percent": str(ratio)})
    return out


# ---------------------------------------------------------------- decisions (reuse hosted rules)

def apply_decision(state: dict, assessment_record: dict, action: str, actor: dict, decided_at: str,
                   edited_statement: str | None = None, run_record_sha256: str | None = None,
                   superseded_by: str | None = None) -> tuple[dict, dict]:
    """Same rules as hosted.service.decide, plus binding, staleness and idempotency for the check state.

    Returns (new_state, decision). `state` is the check's own Standing history; the approved baseline
    artifact is never written."""
    ThesisDecision(thesis_id="T1", assessment_id=assessment_record["assessment_id"], action=action,
                   edited_statement=edited_statement)
    validate_actor(actor)
    if assessment_record.get("assessment") is None:
        raise CheckError("assessment_not_decidable", "There is no parsed assessment to decide on.")
    if assessment_record.get("assessment_sha256", digest(assessment_record["assessment"])) != digest(assessment_record["assessment"]):
        raise CheckError("assessment_binding_mismatch", "The assessment does not match its recorded hash.")
    if superseded_by:
        raise CheckError("assessment_superseded", f"Run {superseded_by} reassessed this event; decide on the current assessment.")
    existing = next((d for d in state["decisions"] if d["assessment_id"] == assessment_record["assessment_id"]), None)
    if existing:
        if existing["action"] == action and existing.get("edited_statement") == edited_statement and existing["actor"] == actor:
            return state, existing          # idempotent repeat
        raise CheckError("decision_already_recorded", "This assessment already has a different decision.")
    current = state["versions"][-1]
    if assessment_record["base_standing_sha256"] != digest(current["standing"]):
        raise CheckError("stale_assessment", "The Standing changed after this assessment; assess again before deciding.")
    if assessment_record.get("publish_status") != "validated" and action in {"accept", "edit"}:
        raise CheckError("assessment_not_validated", "Only a validated assessment can be accepted or edited.")
    assessment = assessment_record["assessment"]
    standing = current["standing"]
    changed = False
    new_standing = standing
    if action in {"accept", "edit"}:
        if not assessment["relevant"] or assessment["proposed_change"]["action"] != "revise":
            raise CheckError("no_revision", "There is no validated suggested revision to apply.")
        statement = edited_statement if action == "edit" else assessment["proposed_change"]["revised_statement"]
        # Same bounds as hosted DecisionRequest / Standing.
        if not isinstance(statement, str) or not 10 <= len(statement.strip()) <= 2000:
            raise CheckError("invalid_input", "A Standing statement needs 10–2000 meaningful characters.")
        changed = statement != standing["statement"]
        if changed and standing["version"] >= 10000:
            raise CheckError("invalid_input", "The thesis version limit has been reached.")
        if changed:
            new_standing = {**standing, "statement": statement, "version": standing["version"] + 1}
    decision = {"assessment_id": assessment_record["assessment_id"], "event_id": assessment_record["event_id"],
                "assessment_sha256": digest(assessment), "assessment_publish_status": assessment_record.get("publish_status"),
                "run_record_sha256": run_record_sha256,
                "standing_kind": state.get("standing_kind", "owner_approved"),
                "action": action, "edited_statement": edited_statement, "changed": changed,
                "from_version": standing["version"], "version": new_standing["version"],
                "actor": actor, "decided_at": decided_at}
    new_state = json.loads(json.dumps(state))
    new_state["decisions"].append(decision)
    if changed:
        new_state["versions"].append({"standing": new_standing, "time": decided_at,
                                      "from_assessment_id": assessment_record["assessment_id"]})
    return new_state, decision


def new_check_state(standing: dict) -> dict:
    kind = standing_kind(standing)
    note = ("Owner-approved baseline r2 (content approval recorded 2026-10-15T02:06:32Z)." if kind == "owner_approved" else
            f"Historical T0 scenario {standing['provenance']['scenario_id']}: not the Owner's thesis and not Owner-approved.")
    return {"schema_version": "check-state-0.1", "baseline_content_sha256": standing["baseline_content_sha256"],
            **({"standing_kind": kind} if kind != "owner_approved" else {}),
            "versions": [{"standing": standing["hosted_standing"], "time": None, "from_assessment_id": None,
                          "note": note}],
            "decisions": []}


def validate_actor(actor: dict) -> dict:
    """An Owner decision cites where the Owner's own words are; a test decision says it is one."""
    kind = actor.get("kind")
    if kind not in {"owner", "automated_test"} or not str(actor.get("label") or "").strip():
        raise CheckError("invalid_actor", "A decision must name an owner or an explicitly labelled automated test.")
    if kind == "owner":
        wording, source = str(actor.get("wording") or "").strip(), str(actor.get("source") or "").strip()
        if len(wording) < 2 or not re.match(r"^https://", source):
            raise CheckError("invalid_actor", "An Owner decision records the Owner's verbatim wording and an https source.")
    return actor


# ---------------------------------------------------------------- the check

class EvidenceStore:
    """Files under one directory: sources/, runs/, checkpoint.json, check_state.json."""

    def __init__(self, root: Path):
        self.root = Path(root)

    @property
    def checkpoint_path(self) -> Path:
        return self.root / "checkpoint.json"

    @property
    def state_path(self) -> Path:
        return self.root / "check_state.json"

    def write_json(self, relative: str, value: Any) -> Path:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return path

    def write_source(self, accession: str, filename: str, data: bytes) -> str:
        path = self.root / "sources" / accession / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.read_bytes() != data:
            # Never overwrite a stored original; a changed payload is a new revision.
            path = path.with_name(f"{path.stem}.{sha256_bytes(data)[:12]}{path.suffix}")
        path.write_bytes(data)
        return str(path.relative_to(self.root))

    def load_state(self, standing: dict) -> dict:
        if self.state_path.exists():
            return json.loads(self.state_path.read_text(encoding="utf-8"))
        return new_check_state(standing)


class EvidenceCheck:
    def __init__(self, sec, store: EvidenceStore, transport=None, standing: dict | None = None,
                 clock=lambda: datetime.now(timezone.utc), code_revision: str | None = None):
        self.sec, self.store, self.transport = sec, store, transport
        self.standing = standing or load_standing()
        self.clock, self.code_revision = clock, code_revision
        self.reassess: dict | None = None
        self.last_assess_documents: list[dict] = []
        self.model_calls: list[dict] = []
        self.errors: list[dict] = []

    # -- acquisition
    def _acquire(self, ref: FilingRef) -> dict:
        header_url, header = self.sec.filing_header(NVDA_CIK, ref.accession)
        accepted = header_acceptance(header)
        index_url, index = self.sec.filing_index(NVDA_CIK, ref.accession)
        names = [item["name"] for item in index.get("directory", {}).get("item", [])]
        files = [n for n in names if DOC_FILES.search(n) and not SKIP_FILES.search(n)]
        primary = ref.primary_document.split("/")[-1]
        files.sort(key=lambda n: (n != primary, names.index(n)))
        if not files:
            raise CheckError("malformed_acquisition", "Filing index lists no document files.")
        documents = []
        for name in files[:6]:
            url = f"{self.sec.archive_base(NVDA_CIK, ref.accession)}/{name}"
            raw, retrieved = self.sec.fetch(url)
            text = document_text(name, raw)
            if not text.strip():
                raise CheckError("malformed_acquisition", f"Document {name} has no text.")
            documents.append({"source_id": f"sec:{ref.accession}:{name}", "filename": name, "url": url,
                              "sha256": sha256_bytes(raw), "bytes": len(raw), "retrieved_at": retrieved,
                              "text": text, "text_sha256": sha256_text(text), "extractor": EXTRACTOR_VERSION,
                              "_raw": raw})
        filer = header_field(header, "COMPANY CONFORMED NAME")
        return {"header_url": header_url, "index_url": index_url, "accepted_at": accepted,
                "header_form": header_field(header, "CONFORMED SUBMISSION TYPE"),
                "header_filing_date": header_field(header, "FILED AS OF DATE"),
                "filer_name": filer, "documents": documents,
                "content_checksum": digest(sorted((d["filename"], d["sha256"]) for d in documents))}

    def _comparisons(self, refs: list[FilingRef], event_ref: FilingRef, accepted_at: str) -> list[dict]:
        out = []
        for form in ("10-Q", "10-K"):
            prior = [r for r in refs if r.form == form and r.filing_date <= event_ref.filing_date
                     and parse_utc(r.submissions_acceptance) < parse_utc(accepted_at)]
            if not prior:
                continue
            ref = max(prior, key=lambda r: r.filing_date)
            url = f"{self.sec.archive_base(NVDA_CIK, ref.accession)}/{ref.primary_document}"
            raw, retrieved = self.sec.fetch(url)
            text = html_text(raw)
            out.append({"accession": ref.accession, "form": form, "filing_date": ref.filing_date, "url": url,
                        "sha256": sha256_bytes(raw), "text_sha256": sha256_text(text), "retrieved_at": retrieved,
                        "text": text, "_ref": ref})
        return out

    def _call(self, stage: str, context: dict, event_id: str) -> dict:
        if self.transport is None:
            raise CheckError("model_unavailable", "No model transport configured (DEEPSEEK_API_KEY or --executor-url).")
        result = self.transport.run(stage, context, self.standing)
        record = {"call_id": f"{event_id}:{stage}", "stage": stage, "event_id": event_id,
                  "prompt_sha256": result["prompt_sha256"], "context_sha256": result["context_sha256"],
                  "raw_output": result["content"], "raw_output_sha256": sha256_text(result["content"]),
                  **result["meta"]}
        self.model_calls.append(record)
        return record

    # -- event pipeline
    def _event(self, ref: FilingRef, refs: list[FilingRef], as_of: datetime, checkpoint: dict, run_id: str) -> dict:
        """One event end to end. The two phases are separate so a hosted request can run one per call."""
        event, held = self._event_triage(ref, as_of, checkpoint, run_id)
        if held is None:
            return event
        return self._event_assess(event, ref, refs, as_of, checkpoint, run_id, held)

    def stage_documents(self, ref: FilingRef, acquired: dict) -> dict:
        """The bounded event the model stages see, derived deterministically from the acquired documents."""
        return {"event_id": ref.event_id, "form": ref.form, "filing_date": ref.filing_date,
                "accepted_at": acquired["accepted_at"], "items": ref.items,
                "documents": self._bounded_documents(acquired["documents"], 40000)}

    def _event_triage(self, ref: FilingRef, as_of: datetime, checkpoint: dict, run_id: str) -> tuple[dict, dict | None]:
        """Stage 0, acquisition, identity/dedupe and Stage 1. Returns (event, held): `held` is None when
        the event reached an outcome here, else what the assessment phase needs (Watch Item evidence or
        uncertain)."""
        event = {"event_id": ref.event_id, "accession": ref.accession, "form": ref.form, "filing_date": ref.filing_date,
                 "report_date": ref.report_date or None, "items": ref.items or None,
                 "timestamps": {"edgar_submissions_acceptance_raw": ref.submissions_acceptance}}
        # Stage 0 from index metadata: no fetch for structural noise.
        if ref.form in THIRD_PARTY_OWNERSHIP_FORMS:
            return {**event, "stage0": {"result": "filtered", "reason": "third_party_ownership_report"}}, None
        if ref.form in REGISTRATION_FORMS:
            return {**event, "stage0": {"result": "filtered", "reason": "registration_or_offering_document"}}, None
        if ref.form not in ISSUER_REPORT_FORMS:
            return {**event, "stage0": {"result": "filtered", "reason": "unsupported_form_type"}}, None
        try:
            acquired = self._acquire(ref)
        except Exception as exc:  # recorded, never silently dropped
            code = getattr(exc, "code", None) or getattr(exc, "reason", None) or type(exc).__name__
            event["stage0"] = {"result": "failed", "reason": "acquisition_failed", "error": str(code),
                               "note": "A failed fetch is not evidence that nothing relevant happened."}
            return self._record_processed(event, checkpoint, run_id, "acquisition_failed", terminal=False), None
        event["timestamps"].update(header_acceptance_utc=acquired["accepted_at"], header_url=acquired["header_url"],
                                   retrieved_at=min(d["retrieved_at"] for d in acquired["documents"]))
        event["filer_name"] = acquired["filer_name"]
        event["content_checksum"] = acquired["content_checksum"]
        event["sources"] = [{k: v for k, v in d.items() if k not in {"text", "_raw"}} for d in acquired["documents"]]
        if not available_by(ref, as_of, acquired["accepted_at"]):
            return {**event, "stage0": {"result": "filtered", "reason": "outside_as_of_window"}}, None
        if acquired["header_form"] != ref.form:
            event["stage0"] = {"result": "failed", "reason": "malformed_acquisition",
                               "error": "header form type disagrees with index"}
            return self._record_processed(event, checkpoint, run_id, "malformed_acquisition", terminal=False), None
        previous = checkpoint["processed"].get(ref.event_id)
        reassessing = self.reassess is not None and self.reassess["event_id"] == ref.event_id
        if reassessing and (not previous or previous["content_checksum"] != acquired["content_checksum"]):
            event["stage0"] = {"result": "failed", "reason": "reassessment_source_changed",
                               "error": "the stored original no longer matches what EDGAR serves"}
            return self._record_processed(event, checkpoint, run_id, "reassessment_source_changed", terminal=False), None
        if previous and previous["content_checksum"] == acquired["content_checksum"] and not reassessing:
            return {**event, "stage0": {"result": "filtered", "reason": "duplicate_already_processed",
                                        "first_run_id": previous["run_id"]}}, None
        revision_of = None
        if previous and not reassessing:
            revision_of = previous["content_checksum"]
            event["event_id"] = f"{ref.event_id}#{acquired['content_checksum'][:12]}"
        for doc in acquired["documents"]:
            doc["stored_path"] = self.store.write_source(ref.accession, doc["filename"], doc["_raw"])
        event["sources"] = [{k: v for k, v in d.items() if k not in {"text", "_raw"}} for d in acquired["documents"]]
        event["stage0"] = {"result": "candidate", "reason": "eligible_issuer_document",
                           **({"content_changed_since_processed": True, "previous_checksum": revision_of} if revision_of else {}),
                           **({"reassessment_of_run_id": previous["run_id"]} if reassessing else {})}
        documents = acquired["documents"]
        stage_event = self.stage_documents(ref, acquired)
        full = {d["source_id"]: d for d in documents}
        seen = lambda docs: [{**d, "full_text": full[d["source_id"]]["text"],
                              "text_sha256": full[d["source_id"]]["text_sha256"]} for d in docs]

        # Stage 1: light triage against every approved Watch Item.
        triage_context = TriageContext(standing_sha256=standing_sha256(self.standing), as_of=utc(as_of),
                                       event=stage_event).model_dump(mode="json")
        try:
            call = self._call("triage", triage_context, event["event_id"])
        except CheckError as exc:
            self.errors.append({"event_id": event["event_id"], "stage": "triage", "code": exc.code})
            event["stage1"] = {"result": "blocked", "reason": exc.code}
            return self._record_processed(event, checkpoint, run_id, "triage_blocked", terminal=False), None
        triage_user = build_model_request("triage", triage_context, self.standing)["user"]
        triage, errors, bindings, effective = validate_triage(call["raw_output"], self.standing,
                                                              seen(stage_event["documents"]), allowed_numbers(triage_user))
        event["stage1"] = {"contract": triage_context["schema_version"], "model_call_id": call["call_id"],
                           "output": triage, "validation_errors": errors, "quote_bindings": bindings}
        if errors or effective is None:
            # Unvalidated output is not a verdict: retried (bounded) and it holds the checkpoint.
            event["stage1"]["result"] = "rejected"
            event["outcome"] = "triage_rejected_needs_review"
            return self._record_processed(event, checkpoint, run_id, event["outcome"], terminal=False), None
        event["stage1"]["model_classification"] = triage["classification"]
        event["stage1"]["effective"] = effective
        event["stage1"]["result"] = effective["classification"]
        if effective["classification"] == "irrelevant":
            event["research"] = {"executed": False, "deep_research_calls": 0, "reason": "stage1_irrelevant"}
            event["outcome"] = "irrelevant_stopped"
            return self._record_processed(event, checkpoint, run_id, event["outcome"]), None
        if effective["classification"] == "driver_context":
            # Related to a driver, but no Watch Item question is answered: noted, not researched,
            # not assessed and nothing for the investor to decide.
            event["research"] = {"executed": False, "deep_research_calls": 0, "reason": "no_watch_item_answered",
                                 "note": "Driver context is recorded for the reader; it reopens no research need."}
            event["context"] = {"driver_ids": sorted({n["driver_id"] for n in effective["driver_context"]}),
                                "notes": effective["driver_context"], "demoted_answers": effective["demoted_answers"]}
            event["decision_status"] = "no_decision_required"
            event["outcome"] = "driver_context_noted"
            return self._record_processed(event, checkpoint, run_id, event["outcome"]), None

        return event, {"acquired": acquired, "triage": triage, "effective": effective}

    def _event_assess(self, event: dict, ref: FilingRef, refs: list[FilingRef], as_of: datetime, checkpoint: dict,
                      run_id: str, held: dict) -> dict:
        """Selective scope, deterministic research and the Stage 2 assessment for one triaged event."""
        acquired, triage, effective = held["acquired"], held["triage"], held["effective"]
        documents = acquired["documents"]
        stage_event = self.stage_documents(ref, acquired)
        full = {d["source_id"]: d for d in documents}
        seen = lambda docs: [{**d, "full_text": full[d["source_id"]]["text"],
                              "text_sha256": full[d["source_id"]]["text_sha256"]} for d in docs]

        # Selective scope: approved Watch Item -> Research Need -> Driver graph (code-derived gaps).
        index = watch_index(self.standing)
        scoped_ids = [a["watch_item_id"] for a in effective["watch_item_answers"]] + effective["uncertain_watch_item_ids"]
        hit = [index[w] for w in scoped_ids]
        monitorable = hit
        gaps = [index[w] for w in effective["gap_watch_item_ids"]]
        all_needs = [w for d in self.standing["drivers"] for w in d["watch_items"]]
        named = {h["id"] for h in hit} | {g["id"] for g in gaps}
        scope = {"total_research_needs": len(all_needs),
                 "monitorable_research_needs": sum(w["monitorable"] for w in all_needs),
                 "total_drivers": len(self.standing["drivers"]),
                 "affected_watch_item_ids": [w["id"] for w in hit],
                 "affected_driver_ids": sorted({w["driver_id"] for w in hit}),
                 "reopened_research_need_ids": [w["research_need_id"] for w in monitorable],
                 "gap_research_need_ids": [w["research_need_id"] for w in gaps],
                 "gap_rule": "unobservable Watch Items under the same falsifiers (derived by code)",
                 "skipped_research_need_ids": [w["research_need_id"] for w in all_needs if w["id"] not in named]}
        event["scope"] = scope
        if effective["driver_context"]:
            event["context"] = {"driver_ids": sorted({n["driver_id"] for n in effective["driver_context"]}),
                                "notes": effective["driver_context"], "demoted_answers": effective["demoted_answers"]}

        # Stage 2 deterministic research.
        text = "\n".join(d["text"] for d in documents)
        items = form8k_items(documents[0]["text"]) if ref.form.startswith("8-K") else []
        section = "\n".join(i["text"] for i in items if i["item"] != "9.01") if items else text
        comparisons = self._comparisons(refs, ref, ref.submissions_acceptance)
        diff = risk_factor_diff(section, comparisons)
        periodic = next((c["_ref"] for c in comparisons if c["form"] == "10-Q"), None)
        try:
            facts = self.sec.companyfacts(NVDA_CIK)
            xbrl = xbrl_context(facts, periodic, as_of)
            xbrl["companyfacts_sha256"] = digest(facts)
            xbrl["retrieved_at"] = utc(self.clock())
        except Exception as exc:
            xbrl = {"status": "unavailable", "error": getattr(exc, "reason", type(exc).__name__), "observations": []}
        amounts = stated_amounts(section)
        deterministic = {"sections": [{"item": i["item"], "chars": len(i["text"])} for i in items] or
                         [{"item": "whole_document", "chars": len(section)}],
                         "risk_factor_diff": {k: v for k, v in diff.items() if k != "compared_with"} |
                         {"compared_with": [{k: c[k] for k in ("accession", "form", "filing_date")} for c in comparisons]},
                         "stated_amounts": [{k: a[k] for k in ("quoted", "value_usd")} for a in amounts],
                         "xbrl_observations": [{k: o.get(k) for k in ("tag", "basis", "status", "value", "unit", "start",
                                                                      "end", "fiscal_year", "fiscal_period", "accession")}
                                               for o in xbrl.get("observations", [])],
                         "derived": derived_ratios(amounts, xbrl)}
        event["research"] = {"executed": True, "section_items": [i["item"] for i in items],
                             "risk_factor_diff": diff, "stated_amounts": amounts, "xbrl": xbrl,
                             "derived": deterministic["derived"]}
        section_doc = [{"source_id": documents[0]["source_id"], "filename": documents[0]["filename"], "text": section[:40000]}] \
            if items else stage_event["documents"]
        self.last_assess_documents = section_doc     # the exact text Stage 2 sees (quotes bind to it)
        assess_context = AssessContext(
            standing_sha256=standing_sha256(self.standing), as_of=utc(as_of),
            event={**stage_event, "documents": section_doc},
            driver_ids=sorted({w["driver_id"] for w in monitorable}),
            watch_item_ids=[w["id"] for w in monitorable],
            research_need_ids=[w["research_need_id"] for w in monitorable],
            triage={"classification": effective["classification"], "rationale": triage["rationale"],
                    "answers": effective["watch_item_answers"],
                    "uncertain_watch_item_ids": effective["uncertain_watch_item_ids"],
                    "gap_watch_item_ids": [w["id"] for w in gaps]},
            deterministic=deterministic).model_dump(mode="json")
        try:
            call = self._call("assess", assess_context, event["event_id"])
        except CheckError as exc:
            self.errors.append({"event_id": event["event_id"], "stage": "assess", "code": exc.code})
            event["assessment"] = {"result": "blocked", "reason": exc.code}
            event["outcome"] = "assessment_blocked"
            return self._record_processed(event, checkpoint, run_id, event["outcome"], terminal=False)
        user = build_model_request("assess", assess_context, self.standing)["user"]
        assessment, errors, evidence = validate_assessment(call["raw_output"], user, seen(section_doc),
                                                           set(assess_context["driver_ids"]),
                                                           "uncertain" if effective["classification"] == "uncertain" else "relevant")
        status = "rejected" if errors or assessment is None else "validated"
        state = self.store.load_state(self.standing)
        record = {"assessment_id": f"{run_id}:{event['event_id']}", "event_id": event["event_id"],
                  "model_call_id": call["call_id"], "assessment": assessment, "publish_status": status,
                  "validation_errors": errors, "evidence": evidence,
                  "base_standing_sha256": digest(state["versions"][-1]["standing"]),
                  "base_standing_version": state["versions"][-1]["standing"]["version"],
                  "semantic_entailment_checked": False, "source_class_note":
                  "SEC EDGAR filer documents; quotes are verbatim matches, not proof of semantic entailment.",
                  "standing_kind": standing_kind(self.standing)}
        record["assessment_sha256"] = digest(assessment) if assessment is not None else None
        event["assessment"] = record
        event["research"]["deep_research_calls"] = 1
        event["what_changed"] = self._what_changed(event, record, diff, xbrl, amounts)
        event["decision_status"] = "awaiting_owner_decision" if status == "validated" else "not_decidable"
        event["outcome"] = f"assessed_{status}"
        return self._record_processed(event, checkpoint, run_id, event["outcome"], terminal=status == "validated")

    @staticmethod
    def _bounded_documents(documents: list[dict], budget: int) -> list[dict]:
        out, used = [], 0
        for d in documents:
            take = d["text"][: max(0, budget - used)]
            if not take:
                break
            out.append({"source_id": d["source_id"], "filename": d["filename"], "text": take})
            used += len(take)
        return out

    def _record_processed(self, event: dict, checkpoint: dict, run_id: str, outcome: str, terminal: bool = True) -> dict:
        """Terminal outcomes are processed; anything else holds the checkpoint and is retried (bounded)."""
        event.setdefault("outcome", outcome)
        key = event["event_id"].split("#")[0]
        if terminal:
            before = checkpoint["processed"].get(key)
            entry = {"content_checksum": event["content_checksum"], "outcome": outcome, "run_id": run_id}
            if before and before["content_checksum"] == event["content_checksum"]:
                # A reassessment replaces the current outcome; the earlier one stays in the history.
                entry["history"] = before.get("history", []) + [{k: before[k] for k in ("outcome", "run_id")}]
            checkpoint["processed"][key] = entry
            checkpoint["failures"].pop(key, None)
        else:
            attempts = checkpoint["failures"].get(key, {"attempts": 0})["attempts"] + 1
            checkpoint["failures"][key] = {
                "attempts": attempts, "last_error": outcome, "last_run_id": run_id,
                "status": "failed_permanent" if attempts >= MAX_FAILURE_ATTEMPTS else "retry_next_run"}
            event["failure"] = checkpoint["failures"][key]
        return event

    def _what_changed(self, event: dict, record: dict, diff: dict, xbrl: dict, amounts: list[dict]) -> dict:
        a = record["assessment"]
        if a is None:
            return {"event_id": event["event_id"], "publish_status": "rejected", "validation_errors": record["validation_errors"]}
        state = self.store.load_state(self.standing)
        before = state["versions"][-1]["standing"]["statement"]
        proposal = a["proposed_change"]
        observed = [{"kind": "verbatim_quote", "statement": f["statement"], "exact_quote": f["exact_quote"],
                     **next(({"source_id": e["source_id"], "offset": e["offset"]} for e in record["evidence"]
                             if e["exact_quote"] == f["exact_quote"]), {"source_id": None})} for f in a["observed_facts"]]
        observed += [{"kind": "deterministic_text_diff", "statement": s, "source_id": event["sources"][0]["source_id"],
                      "compared_with": [c["accession"] for c in diff["compared_with"]]} for s in diff["new_sentences"][:12]]
        observed += [{"kind": "xbrl", **{k: o[k] for k in ("tag", "basis", "value", "unit", "start", "end",
                                                              "fiscal_year", "fiscal_period", "accession")}}
                     for o in xbrl.get("observations", []) if o.get("status") == "resolved"]
        return {"event_id": event["event_id"], "source_ids": [s["source_id"] for s in event["sources"]],
                "affected_drivers": event["scope"]["affected_driver_ids"], "observed_facts": observed,
                "what_changed": a["what_changed"], "direction": a["relation"], "materiality": a["materiality"],
                "driver_impacts": a["driver_impacts"], "counter_reading": a["counter_reading"],
                "uncertainties": a["uncertainties"], "proposed_action": PROPOSED_ACTION[proposal["action"]],
                "proposed_delta": {"before": before, "after": proposal["revised_statement"]} if proposal["action"] == "revise" else None,
                "proposal_reason": proposal["reason"], "what_to_watch_next": a["what_to_watch"],
                "publish_status": record["publish_status"], "validation_errors": record["validation_errors"],
                "automatic_thesis_mutation": False}

    def run(self, as_of: datetime, run_label: str | None = None, reassess: dict | None = None) -> dict:
        """One check at an as_of clock.

        `reassess` = {"event_id", "supersedes_run_id", "reason"} re-runs one already-processed event
        under the current contracts at the superseded run's own clock. The earlier Run Record is
        never edited; the new record names it, and the checkpoint keeps both outcomes."""
        started = time.perf_counter()
        run_at = self.clock()
        if standing_kind(self.standing) == SCENARIO_KIND and \
                parse_utc(self.standing["provenance"]["authored_at"]) > run_at:
            raise CheckError("scenario_not_yet_authored",
                             "A scenario cannot execute before its recorded authorship time.")
        run_id = f"chk_{run_at.strftime('%Y%m%dT%H%M%SZ')}" + (f"_{run_label}" if run_label else "")
        # Point-in-time validity of the belief itself: a Standing cannot be checked before it existed.
        effective_at = standing_effective_at(self.standing)
        if as_of < effective_at:
            raise CheckError("standing_not_yet_effective",
                             f"The Standing became effective at {utc(effective_at)}; a check at {utc(as_of)} would "
                             "attribute it to a time before it existed.")
        if as_of.date() <= date.fromisoformat(self.standing["evidence_through"]):
            raise CheckError("standing_not_yet_effective", "as_of must be after the Standing's evidence cutoff.")
        state = self.store.load_state(self.standing)
        if state.get("standing_kind", "owner_approved") != standing_kind(self.standing) or \
                state.get("baseline_content_sha256") != self.standing["baseline_content_sha256"]:
            raise CheckError("state_scope_mismatch", "This evidence directory belongs to a different Standing.")
        if state["versions"][-1]["standing"] != self.standing["hosted_standing"]:
            # The model is shown the approved projection; a later Standing version needs its own projection.
            raise CheckError("standing_advanced", "The Standing has moved past the approved baseline; "
                                                  "re-project the check standing before running another check.")
        checkpoint = load_checkpoint(self.store.checkpoint_path, self.standing)
        checkpoint_before = json.loads(json.dumps(checkpoint))
        supersedes = None
        if reassess:
            supersedes = self._superseded(reassess, as_of, checkpoint)
            self.reassess = reassess
        submissions = self.sec.submissions(NVDA_CIK)
        refs = filings_from_submissions(submissions)
        basis = checkpoint["initial_basis"]["evidence_through"]
        after_basis = [r for r in refs if r.filing_date > basis]
        in_window = sorted((r for r in after_basis if available_by(r, as_of)),
                           key=lambda r: (r.submissions_acceptance, r.accession))
        excluded_future = [r.accession for r in after_basis if not available_by(r, as_of)]
        if reassess:
            in_window = [r for r in in_window if r.event_id == reassess["event_id"]]
            if not in_window:
                raise CheckError("reassessment_not_in_window", "The event is not in the window at the superseded clock.")
        events = [self._event(ref, refs, as_of, checkpoint, run_id) for ref in in_window]
        failed = [e["event_id"] for e in events if e.get("failure")]
        excluded_future += [e["accession"] for e in events if e["stage0"].get("reason") == "outside_as_of_window"]
        checkpoint = advance_checkpoint(checkpoint, utc(as_of), run_id, failed)
        deep = sum(e.get("research", {}).get("deep_research_calls", 0) for e in events)
        kind = standing_kind(self.standing)
        mode = "historical_t0_scenario" if kind == SCENARIO_KIND else "historical_replay"
        record = {
            "schema_version": SCHEMA_RUN, "run_id": run_id, "run_at": utc(run_at), "as_of": utc(as_of),
            "mode": mode + ("_reassessment" if reassess else ""), "ticker": TICKER, "cik": NVDA_CIK,
            "standing": {"baseline_id": self.standing["baseline_id"], "version": self.standing["version"],
                         "kind": kind, "baseline_content_sha256": self.standing["baseline_content_sha256"],
                         "check_standing_sha256": standing_sha256(self.standing),
                         "approval": standing_approval_label(self.standing),
                         "effective_at": utc(effective_at),
                         "evidence_through": self.standing["evidence_through"],
                         **({"provenance": self.standing["provenance"]} if kind == SCENARIO_KIND else {})},
            "window": {"rule": "filing_date > evidence_through and every acceptance reading <= as_of",
                       "evidence_through": basis, "as_of": utc(as_of), "excluded_after_as_of": excluded_future,
                       "submissions_retrieved_at": utc(run_at),
                       "submissions_filings_listed": len(refs),
                       **({"restricted_to_event_id": reassess["event_id"]} if reassess else {})},
            **({"supersedes": supersedes} if supersedes else {}),
            "checkpoint": {"path": "checkpoint.json", "scope": checkpoint["scope"],
                           "reviewed_through_before": checkpoint_before["reviewed_through"],
                           "reviewed_through_after": checkpoint["reviewed_through"],
                           "processed_before": len(checkpoint_before["processed"]),
                           "processed_after": len(checkpoint["processed"]), "blocked_by": failed},
            "funnel": run_funnel(events),
            "events": events, "model_calls": self.model_calls,
            "totals": {"model_calls": len(self.model_calls), "deep_research_calls": deep,
                       "triage_calls": sum(c["stage"] == "triage" for c in self.model_calls),
                       "tokens": self._tokens(), "cost": "not measured (provider pricing not verified in this run)",
                       "latency_ms": int((time.perf_counter() - started) * 1000)},
            "prompts": {stage: {"contract": CURRENT_STAGES[stage], "file": f"backend/prompts/{STAGES[stage].prompt_file}",
                                "sha256": sha256_text(prompt_text(stage))} for stage in STAGES},
            "environment": {"code_revision": self.code_revision, "extractor": EXTRACTOR_VERSION,
                            "sec_user_agent": "configured (contact redacted)",
                            "model_knowledge_cutoff": "not observable; contamination probe deferred",
                            "nvidia_ir": "not used: investor.nvidia.com answered a Cloudflare challenge (HTTP 403) to automated requests; SEC exhibits used instead"},
            "errors": self.errors, "human_decision": None,
        }
        record["record_sha256"] = digest({k: v for k, v in record.items() if k != "record_sha256"})
        self.store.write_json(f"runs/{run_id}/run_record.json", record)
        self.store.write_json("checkpoint.json", checkpoint)
        if not self.store.state_path.exists():
            self.store.write_json("check_state.json", state)
        return record

    def _superseded(self, reassess: dict, as_of: datetime, checkpoint: dict) -> dict:
        path = self.store.root / "runs" / reassess["supersedes_run_id"] / "run_record.json"
        if not path.exists():
            raise CheckError("superseded_run_missing", "The run to supersede is not in this evidence directory.")
        old = json.loads(path.read_text(encoding="utf-8"))
        if verify_run_record(old):
            raise CheckError("superseded_run_invalid", "The run to supersede fails its integrity check.")
        if parse_utc(old["as_of"]) != as_of:
            raise CheckError("reassessment_clock_mismatch", "A reassessment uses the superseded run's own as_of clock.")
        if old["standing"]["check_standing_sha256"] != standing_sha256(self.standing):
            raise CheckError("reassessment_standing_mismatch", "A reassessment uses the superseded run's Standing.")
        event = next((e for e in old["events"] if e["event_id"] == reassess["event_id"]), None)
        processed = checkpoint["processed"].get(reassess["event_id"])
        if event is None or processed is None:
            raise CheckError("reassessment_event_missing", "The event was not processed by the superseded run.")
        reason = (reassess.get("reason") or "").strip()
        if len(reason) < 20:
            raise CheckError("invalid_input", "A reassessment needs a stated reason.")
        return {"run_id": old["run_id"], "record_sha256": old["record_sha256"], "event_id": event["event_id"],
                "outcome_before": event.get("outcome"),
                "assessment_id_before": (event.get("assessment") or {}).get("assessment_id"),
                "reason": reason, "original_record_unchanged": True}

    def _tokens(self) -> dict | str:
        usages = [c.get("usage") for c in self.model_calls]
        if not usages or any(u is None for u in usages):
            return "not fully observed" if usages else "no model calls"
        keys = sorted({k for u in usages for k in u})
        return {k: sum(u.get(k, 0) for u in usages) for k in keys}


def run_funnel(events: list[dict]) -> dict:
    """N filings -> Stage 0 -> Stage 1 classes -> proposals, counted the same way for every run."""
    stage1 = lambda value: sum(e.get("stage1", {}).get("result") == value for e in events)
    filtered = sorted({e["stage0"].get("reason") for e in events if e["stage0"]["result"] == "filtered"})
    return {"in_window": len(events), "fetched": sum(bool(e.get("sources")) for e in events),
            "stage0_kept": sum(e["stage0"]["result"] == "candidate" for e in events),
            "stage0_filtered": {reason: sum(e["stage0"].get("reason") == reason and e["stage0"]["result"] == "filtered"
                                            for e in events) for reason in filtered},
            "stage0_failed": sum(e["stage0"]["result"] == "failed" for e in events),
            "watch_item_evidence": stage1("watch_item_evidence"), "driver_context": stage1("driver_context"),
            "uncertain": stage1("uncertain"), "irrelevant": stage1("irrelevant"),
            "rejected": stage1("rejected"),
            "demoted_by_code": sum(bool(e.get("stage1", {}).get("effective", {}).get("demoted_answers")) for e in events),
            "proposals": sum(e.get("what_changed", {}).get("proposed_action") == "propose_revision" for e in events)}


def verify_run_record(record: dict) -> list[str]:
    """Integrity: the hash covers the record, and every model-derived stage names a recorded call."""
    problems = []
    if record.get("schema_version") not in RECORD_SCHEMAS:
        problems.append("unknown_record_schema")
    if record.get("record_sha256") != digest({k: v for k, v in record.items() if k != "record_sha256"}):
        problems.append("record_sha256_mismatch")
    calls = {c["call_id"]: c for c in record["model_calls"]}
    for event in record["events"]:
        for stage in ("stage1", "assessment"):
            call_id = (event.get(stage) or {}).get("model_call_id")
            if call_id and call_id not in calls:
                problems.append(f"missing_model_call:{call_id}")
    return problems


def json_pointer(document: Any, pointer: str) -> Any:
    """RFC 6901 lookup; raises KeyError/IndexError when the path does not exist."""
    value = document
    for part in pointer.lstrip("/").split("/") if pointer else []:
        part = part.replace("~1", "/").replace("~0", "~")
        value = value[int(part)] if isinstance(value, list) else value[part]
    return value


def load_runs(root: Path) -> dict[str, dict]:
    return {p.parent.name: json.loads(p.read_text(encoding="utf-8")) for p in sorted((Path(root) / "runs").glob("*/run_record.json"))}


def superseded_by(runs: dict[str, dict], run_id: str, event_id: str) -> str | None:
    """The run that reassessed this event of this run, if any."""
    for other in runs.values():
        sup = other.get("supersedes") or {}
        if sup.get("run_id") == run_id and sup.get("event_id") == event_id:
            return other["run_id"]
    return None


def verify_evidence(root: Path) -> list[str]:
    """Join and verify everything a reader relies on, without trusting any single file.

    - every Run Record: hash, schema, model-call references;
    - supersession: the superseded record exists and still has the hash the newer record cites;
    - annotations: bound to (run_id, record_sha256, JSON pointer) and the quoted text is still there;
    - decisions: each names an assessment that exists in a verified record with the same content hash,
      and no decision is attached to an assessment that a later run superseded before the decision.
    """
    root = Path(root)
    problems: list[str] = []
    runs = load_runs(root)
    correction_path = root / "provenance_corrections.json"
    corrections = (json.loads(correction_path.read_text(encoding="utf-8")).get("corrections", [])
                   if correction_path.exists() else [])
    corrected = set()
    for note in corrections:
        run_id = note.get("run_id")
        record = runs.get(run_id)
        if not record or record.get("record_sha256") != note.get("record_sha256"):
            problems.append(f"provenance_correction:{run_id}:record_missing_or_changed")
            continue
        provenance = record.get("standing", {}).get("provenance") or {}
        if provenance.get("authored_at") != note.get("recorded_authored_at") or \
                record.get("run_at") != note.get("recorded_run_at"):
            problems.append(f"provenance_correction:{run_id}:timestamp_binding_mismatch")
            continue
        try:
            source_time = parse_utc(note["source_commit_time"])
            if source_time > parse_utc(record["run_at"]):
                problems.append(f"provenance_correction:{run_id}:source_commit_after_run")
                continue
        except (KeyError, ValueError, TypeError):
            problems.append(f"provenance_correction:{run_id}:invalid_source_commit_time")
            continue
        if not re.fullmatch(r"[0-9a-f]{40}", note.get("source_commit_sha", "")):
            problems.append(f"provenance_correction:{run_id}:invalid_source_commit_sha")
            continue
        corrected.add(run_id)
    for run_id, record in runs.items():
        provenance = record.get("standing", {}).get("provenance") or {}
        if provenance.get("kind") == SCENARIO_KIND:
            try:
                if parse_utc(provenance["authored_at"]) > parse_utc(record["run_at"]) and run_id not in corrected:
                    problems.append(f"{run_id}:scenario_authored_after_run_unannotated")
            except (KeyError, ValueError, TypeError):
                problems.append(f"{run_id}:scenario_authorship_metadata_invalid")
    for run_id, record in runs.items():
        problems += [f"{run_id}:{p}" for p in verify_run_record(record)]
        if record.get("run_id") != run_id:
            problems.append(f"{run_id}:run_id_differs_from_directory")
        sup = record.get("supersedes")
        if sup:
            old = runs.get(sup["run_id"])
            if old is None:
                problems.append(f"{run_id}:supersedes_missing_run:{sup['run_id']}")
            elif old["record_sha256"] != sup["record_sha256"]:
                problems.append(f"{run_id}:superseded_record_changed:{sup['run_id']}")
            elif not any(e["event_id"] == sup["event_id"] for e in old["events"]):
                problems.append(f"{run_id}:superseded_event_missing:{sup['event_id']}")
    annotations_path = root / "annotations.json"
    if annotations_path.exists():
        for a in json.loads(annotations_path.read_text(encoding="utf-8"))["annotations"]:
            record = runs.get(a["run_id"])
            if record is None or record["record_sha256"] != a["record_sha256"]:
                problems.append(f"annotation:{a['id']}:record_missing_or_changed")
                continue
            try:
                target = json_pointer(record, a["pointer"])
            except (KeyError, IndexError, ValueError, TypeError):
                problems.append(f"annotation:{a['id']}:pointer_unresolved")
                continue
            if a.get("quoted") and a["quoted"] not in canonical_json(target):
                problems.append(f"annotation:{a['id']}:quoted_text_not_at_pointer")
            if a.get("superseded_by_run_id") and a["superseded_by_run_id"] not in runs:
                problems.append(f"annotation:{a['id']}:superseding_run_missing")
    state_path = root / "check_state.json"
    if state_path.exists():
        assessments = {}
        for record in runs.values():
            for e in record["events"]:
                a = e.get("assessment")
                if isinstance(a, dict) and "assessment_id" in a:
                    assessments[a["assessment_id"]] = (record, e, a)
        for d in json.loads(state_path.read_text(encoding="utf-8"))["decisions"]:
            found = assessments.get(d["assessment_id"])
            if found is None:
                problems.append(f"decision:{d['assessment_id']}:assessment_missing")
                continue
            record, e, a = found
            if d.get("assessment_sha256") and d["assessment_sha256"] != digest(a["assessment"]):
                problems.append(f"decision:{d['assessment_id']}:assessment_changed")
            if d.get("run_record_sha256") and d["run_record_sha256"] != record["record_sha256"]:
                problems.append(f"decision:{d['assessment_id']}:record_changed")
            later = superseded_by(runs, record["run_id"], e["event_id"])
            if later and runs[later]["run_at"] <= d["decided_at"]:
                problems.append(f"decision:{d['assessment_id']}:decided_after_supersession")
            try:
                validate_actor(d["actor"])
            except CheckError:
                problems.append(f"decision:{d['assessment_id']}:actor_invalid")
    return problems


# ---------------------------------------------------------------- CLI

def _git_revision() -> str | None:
    head = REPO / ".git" / "HEAD"
    try:
        ref = head.read_text().strip()
        if ref.startswith("ref: "):
            return (REPO / ".git" / ref[5:]).read_text().strip()
        return ref
    except OSError:
        return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m living_thesis.evidence_check")
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="Run one check at an as_of clock and write a Run Record")
    run.add_argument("--as-of", required=True, help="UTC clock, e.g. 2026-10-16T00:00:00Z")
    run.add_argument("--evidence-dir", default=str(LIVE_EVIDENCE_DIR))
    run.add_argument("--executor-url", help="Hosted function that runs model stages with its own key "
                                           "(reads the Preview access token from EVIDENCE_CHECK_TOKEN)")
    run.add_argument("--label")
    run.add_argument("--standing", help="A committed historical T0 scenario Standing (default: the approved Standing)")
    run.add_argument("--reassess-event", help="Re-run one processed event under the current contracts")
    run.add_argument("--supersedes-run", help="The run whose outcome for --reassess-event is superseded")
    run.add_argument("--reason", help="Why the earlier outcome is reassessed (recorded)")
    decide = sub.add_parser("decide", help="Record an explicit human decision on an assessed event")
    decide.add_argument("--run-id", required=True)
    decide.add_argument("--event-id", required=True)
    decide.add_argument("--action", required=True, choices=["accept", "edit", "reject", "keep_unresolved"])
    decide.add_argument("--edited-statement")
    decide.add_argument("--actor-kind", required=True, choices=["owner", "automated_test"])
    decide.add_argument("--actor-label", required=True)
    decide.add_argument("--owner-wording", help="The Owner's verbatim instruction (owner decisions)")
    decide.add_argument("--owner-source", help="https link to where the Owner's instruction is recorded")
    decide.add_argument("--evidence-dir", default=str(LIVE_EVIDENCE_DIR))
    verify = sub.add_parser("verify", help="Verify Run Records, supersessions, annotations and decisions")
    verify.add_argument("--evidence-dir", default=str(LIVE_EVIDENCE_DIR))
    sub.add_parser("project-standing", help="Regenerate the committed check-standing projection")
    args = parser.parse_args(argv)

    if args.command == "project-standing":
        artifact = json.loads(BASELINE_ARTIFACT.read_text(encoding="utf-8"))
        STANDING_PROJECTION.write_text(json.dumps(project_check_standing(artifact), ensure_ascii=False, indent=2) + "\n",
                                       encoding="utf-8")
        print("wrote", STANDING_PROJECTION.relative_to(REPO))
        return 0
    store = EvidenceStore(Path(args.evidence_dir))
    if args.command == "verify":
        problems = verify_evidence(store.root)
        print(json.dumps({"evidence_dir": str(store.root), "runs": len(load_runs(store.root)), "problems": problems}, indent=2))
        return 1 if problems else 0
    if args.command == "decide":
        record = json.loads((store.root / "runs" / args.run_id / "run_record.json").read_text(encoding="utf-8"))
        if verify_run_record(record):
            print("Run Record failed its integrity check; refusing to decide.", file=sys.stderr)
            return 2
        event = next((e for e in record["events"] if e["event_id"] == args.event_id), None)
        if not event or not isinstance(event.get("assessment"), dict) or "assessment_id" not in event["assessment"]:
            print("No assessed event with that ID in the run.", file=sys.stderr)
            return 2
        call = next((c for c in record["model_calls"] if c["call_id"] == event["assessment"]["model_call_id"]), None)
        if call is None or EventAssessment.model_validate_json(call["raw_output"]).model_dump(mode="json") \
                != event["assessment"]["assessment"]:
            print("The recorded assessment does not match the recorded model output; refusing to decide.", file=sys.stderr)
            return 2
        if args.actor_kind == "automated_test" and store.root.resolve() == LIVE_EVIDENCE_DIR.resolve():
            print("Automated test decisions are never written to the live evidence directory.", file=sys.stderr)
            return 2
        actor = {"kind": args.actor_kind, "label": args.actor_label}
        if args.actor_kind == "owner":
            actor.update(wording=args.owner_wording or "", source=args.owner_source or "")
        standing = standing_for_sha(record["standing"]["check_standing_sha256"])
        try:
            state, decision = apply_decision(store.load_state(standing), event["assessment"], args.action, actor,
                                             utc(datetime.now(timezone.utc)), args.edited_statement,
                                             run_record_sha256=record["record_sha256"],
                                             superseded_by=superseded_by(load_runs(store.root), record["run_id"], event["event_id"]))
        except CheckError as exc:
            print(f"{exc.code}: {exc}", file=sys.stderr)
            return 2
        store.write_json("check_state.json", state)
        print(json.dumps(decision, ensure_ascii=False, indent=2))
        return 0
    from .sec_client import SecClient
    agent = os.environ.get("SEC_USER_AGENT", "")
    sec = SecClient(agent)
    standing = load_scenario_standing(Path(args.standing)) if args.standing else load_standing()
    if standing_kind(standing) == SCENARIO_KIND and store.root.resolve() == LIVE_EVIDENCE_DIR.resolve():
        print("A scenario Standing never runs in the live evidence directory.", file=sys.stderr)
        return 2
    transport = None
    if args.executor_url:
        transport = RemoteTransport(args.executor_url)
        transport.describe()
    elif os.environ.get("DEEPSEEK_API_KEY"):
        transport = DeepSeekTransport(os.environ["DEEPSEEK_API_KEY"])
    reassess = None
    if args.reassess_event:
        reassess = {"event_id": args.reassess_event, "supersedes_run_id": args.supersedes_run, "reason": args.reason}
    record = EvidenceCheck(sec, store, transport, standing=standing, code_revision=_git_revision()).run(
        parse_utc(args.as_of), args.label, reassess=reassess)
    print(json.dumps({"run_id": record["run_id"], "funnel": record["funnel"], "totals": record["totals"],
                      "errors": record["errors"], "checkpoint": record["checkpoint"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
