"""Verifiable lineage from the Owner-approved NVIDIA baseline to an investor's durable workspace.

Eligibility for automated Check for Updates is never inferred from a ticker or from text the
browser sent. The server builds an adopted workspace's first Standing itself, from the committed
projection of the approved artifact, and records that lineage. Every later read re-verifies it.
"""
from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from functools import lru_cache
from pathlib import Path

PROJECTION = Path(__file__).resolve().parent / "nvda_baseline_standings.json"
APPROVED_CONTENT_SHA256 = "634b812149c40bc129221b0ba451e210319fdc17847e1b80a8c91528777150ee"
BASELINE_ID = "NVDA_PRODUCT_BASELINE_V1"
LINEAGE_KIND = "owner_approved_baseline"


def digest(value) -> str:
    """Same canonical JSON hash as durable_service.content_digest and evidence_check.digest."""
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
                          .encode("utf-8")).hexdigest()


@lru_cache(maxsize=1)
def _projection() -> dict:
    data = json.loads(PROJECTION.read_text(encoding="utf-8"))
    if data.get("baseline_content_sha256") != APPROVED_CONTENT_SHA256 or data.get("baseline_id") != BASELINE_ID:
        raise RuntimeError("The adoption projection is not bound to the Owner-approved baseline.")
    return data


def approval_recorded_at() -> str:
    return _projection()["approval_recorded_at"]


def adoption_standing(language: str) -> dict:
    standings = _projection()["standings"]
    if language not in standings:
        raise ValueError("Unsupported adoption language")
    return deepcopy(standings[language])


def check_standing_sha256() -> str:
    from backend.src.living_thesis import evidence_check as ec
    return ec.standing_sha256(ec.load_standing())


def monitoring_rules(standing: dict) -> dict:
    """The parts of a Standing that carry the approved monitoring rules (everything but the statement)."""
    return {key: deepcopy(value) for key, value in standing.items() if key not in {"statement", "version"}}


def new_lineage(language: str, stamp: str) -> dict:
    standing = adoption_standing(language)
    return {"kind": LINEAGE_KIND, "baseline_id": BASELINE_ID, "baseline_content_sha256": APPROVED_CONTENT_SHA256,
            "check_standing_sha256": check_standing_sha256(), "approval_recorded_at": approval_recorded_at(),
            "language": language, "adopted_at": stamp, "adopted_standing_sha256": digest(standing),
            "monitoring": [{"version": 1, "statement_sha256": digest(standing["statement"]),
                            "basis": "adoption", "time": stamp}]}


def validate(state: dict) -> None:
    """Raise ValueError unless lineage, check state and check provenance are coherent and server-shaped."""
    lineage, checks = state.get("lineage"), state.get("checks")
    has_check_records = any(record.get("acquisition") for record in state["evidence"]) or \
        any(record.get("check") for record in state["assessments"])
    if lineage is None:
        if checks is not None or has_check_records:
            raise ValueError("Check state without a verified baseline lineage")
        return
    if lineage["baseline_content_sha256"] != APPROVED_CONTENT_SHA256 or lineage["baseline_id"] != BASELINE_ID:
        raise ValueError("Lineage names another baseline")
    if lineage["approval_recorded_at"] != approval_recorded_at():
        raise ValueError("Lineage approval time differs")
    adopted = adoption_standing(lineage["language"])
    first = state["versions"][0]
    if first["standing"] != adopted or lineage["adopted_standing_sha256"] != digest(adopted):
        raise ValueError("The first Standing is not the approved baseline projection")
    if state["history"][0].get("type") != "created" or lineage["adopted_at"] != first["time"]:
        raise ValueError("Lineage must be recorded when the workspace is created")
    snapshots = {v["standing"]["version"]: v["standing"] for v in state["versions"]}
    previous = 0
    for index, entry in enumerate(lineage["monitoring"]):
        if (index == 0) != (entry["basis"] == "adoption") or (index == 0 and entry["version"] != 1):
            raise ValueError("Monitoring confirmations start at adoption")
        if entry["version"] <= previous or entry["version"] not in snapshots:
            raise ValueError("Monitoring confirmations must name increasing recorded versions")
        if entry["statement_sha256"] != digest(snapshots[entry["version"]]["statement"]):
            raise ValueError("A monitoring confirmation names another statement")
        previous = entry["version"]
    evidence = {record["id"]: record for record in state["evidence"]}
    if any(record.get("acquisition") and not record.get("assessmentId") for record in state["evidence"]):
        raise ValueError("Acquired evidence always carries its assessment")
    for record in state["assessments"]:
        source = evidence.get(record["evidenceId"])
        if bool(record.get("check")) != bool(source and source.get("acquisition")):
            raise ValueError("Check assessments and acquired evidence must be paired")
        if record.get("check") and (record["check"].get("event_id") != source["acquisition"].get("event_id")
                                    or record["check"].get("run_id") != source["acquisition"].get("run_id")
                                    or record["check"].get("payload_sha256") != digest(record["payload"])):
            raise ValueError("Check assessment provenance differs from its evidence")
