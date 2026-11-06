"""OFFLINE FIXTURES for Check for Updates: synthetic EDGAR responses and scripted model outputs.

Nothing here is a real NVIDIA filing or a real model call. The SEC shapes and the scripted outputs
are the check core's own offline fixtures (backend/tests/evidence_check_fixture.py); this module
adapts them to the hosted runtime. Results produced with it are labelled fixtures, never evidence.
"""
from __future__ import annotations

import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

from backend.src.living_thesis import evidence_check as ec
from hosted import check_service

_spec = importlib.util.spec_from_file_location(
    "evidence_check_fixture", Path(__file__).resolve().parents[2] / "backend/tests/evidence_check_fixture.py")
fx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fx)

CLOCK = datetime(2026, 10, 19, 0, 0, tzinfo=timezone.utc)

# A revision-proposing assessment grounded in the fixture 8-K (numbers only from the shown text).
REVISE = {**fx.ASSESSMENT, "relation": "weaken", "materiality": "high",
          "driver_impacts": [{"driver_id": "D5", "relation": "weaken", "materiality": "high",
                              "reasoning": "A licence requirement stopped China sales.",
                              "exact_quote": "Export of FixtureCo accelerators to customers in China now requires a license, and sales there have stopped."}],
          "proposed_change": {"action": "revise", "reason": "Market access weakened.",
                              "revised_statement": "NVIDIA's growth thesis holds only if market access outside China offsets the stopped China sales."}}


class Transport:
    """SYNTHETIC model fixture on the hosted core: builds the real request so hashes and scope are exercised."""
    executor = "synthetic_fixture"

    def __init__(self, triage=None, assessment=None, fail=None):
        self.triage = dict(triage or fx.TRIAGE)
        self.assessment = assessment or fx.ASSESSMENT
        self.fail = fail or {}          # {stage: CheckError code} or {stage: "raw:<text>"}
        self.calls: list[dict] = []

    def run(self, stage, context, standing=None):
        request = ec.build_model_request(stage, context, standing)
        accession = context["event"]["event_id"].split(":", 1)[1]
        self.calls.append({"stage": stage, "accession": accession, "user": request["user"]})
        failure = self.fail.get(stage)
        if failure and not failure.startswith("raw:"):
            raise ec.CheckError(failure, "fixture failure")
        content = failure[4:] if failure else json.dumps(self.triage[accession] if stage == "triage" else self.assessment)
        return {"content": content, "prompt_sha256": request["prompt_sha256"], "context_sha256": request["context_sha256"],
                "meta": {"executor": self.executor, "requested_model": "fixture", "response_model": "fixture",
                         "usage": {"prompt_tokens": 10, "completion_tokens": 5}, "latency_ms": 1, "finish_reason": "stop"}}


def runtime(sec=None, transport=None, clock=CLOCK):
    return check_service.Runtime(sec or fx.FakeSec(), transport or Transport(), lambda: clock)
