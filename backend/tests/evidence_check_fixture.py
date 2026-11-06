"""OFFLINE TEST FIXTURES — synthetic SEC responses and scripted model outputs.

Nothing here is a real NVIDIA filing or a real model call. Shapes follow EDGAR's submissions,
index, header and companyfacts formats so the check core's deterministic code is exercised
offline. Live acquisition and model evidence lives only in docs/evidence/nvda/.
"""
from __future__ import annotations

import json

from living_thesis.sec_client import SecClient, SecFetchError

EVENT_8K = "0001045810-26-900001"
NPX = "0001104659-26-900002"
TENQ = "0001045810-26-900003"
FUTURE_8K = "0001045810-26-900004"

EIGHT_K_HTML = """<html><head><title>x</title></head><body>
<div style="display:none"><ix:header>hidden header 99.99</ix:header></div>
<p>FIXTURE CURRENT REPORT</p>
<p>Item 8.01. Other Events.</p>
<p>On September 2, 2026, FixtureCo entered into a definitive agreement to acquire ExampleHub, Inc. for approximately $11.9 billion.</p>
<p>FixtureCo commits to keep the platform open and to support other silicon vendors.</p>
<p>Two large customers began migrating training workloads to alternative accelerators during the quarter.</p>
<p>Export of FixtureCo accelerators to customers in China now requires a license, and sales there have stopped.</p>
<p>Many popular open models originated in China, and restrictions on such models could affect the ExampleHub platform.</p>
<p>Demand for open models promotes the use of our products worldwide and is described in prior reports.</p>
<p>Item 9.01. Financial Statements and Exhibits.</p>
<p>104 Cover Page Interactive Data File.</p>
<p>SIGNATURES</p><p>FixtureCo signature block.</p>
</body></html>"""

NPX_XML = """<?xml version="1.0"?><proxyVoteTable xmlns="http://www.sec.gov/edgar/document/npxproxy/informationtable">
<proxyTable><issuerName>Example Semiconductor Corp</issuerName><voteDescription>Advisory vote on executive compensation.</voteDescription><sharesVoted>0</sharesVoted></proxyTable>
</proxyVoteTable>"""

TENQ_HTML = """<html><body><p>Item 1A. Risk Factors</p>
<p>Demand for open models promotes the use of our products worldwide and is described in prior reports.</p>
<p>Other risks remain as previously described in the fixture filing.</p></body></html>"""


def _recent(rows):
    keys = ["accessionNumber", "form", "filingDate", "reportDate", "primaryDocument", "items", "acceptanceDateTime"]
    return {"filings": {"recent": {k: [r[i] for r in rows] for i, k in enumerate(keys)}}}


SUBMISSIONS = _recent([
    (FUTURE_8K, "8-K", "2026-10-20", "2026-10-19", "future.htm", "8.01", "2026-10-20T16:00:00.000Z"),
    ("0009999999-26-000010", "4", "2026-09-05", "2026-09-03", "xslF345X06/form4.xml", "", "2026-09-06T01:00:00.000Z"),
    ("0009999999-26-000011", "S-8", "2026-09-06", "", "s8.htm", "", "2026-09-06T21:00:00.000Z"),
    ("0009999999-26-000012", "UNKNOWN-X", "2026-09-07", "", "u.htm", "", "2026-09-07T21:00:00.000Z"),
    (EVENT_8K, "8-K", "2026-09-03", "2026-09-02", "fixture-8k.htm", "8.01", "2026-09-03T16:03:56.000Z"),
    (NPX, "N-PX", "2026-08-31", "2026-06-30", "xslN-PX_X01/primary_doc.xml", "", "2026-09-01T00:32:07.000Z"),
    (TENQ, "10-Q", "2026-08-26", "2026-07-26", "fixture-10q.htm", "", "2026-08-27T00:36:00.000Z"),
])

HEADERS = {
    EVENT_8K: ("20260903080356", "8-K"), NPX: ("20260831163207", "N-PX"),
    TENQ: ("20260826163600", "10-Q"), FUTURE_8K: ("20261020120000", "8-K"),
}
FILES = {
    EVENT_8K: {"fixture-8k.htm": EIGHT_K_HTML.encode(), "R1.htm": b"<p>render</p>",
               f"{EVENT_8K}.txt": b"full submission", "fixture-8k_htm.xml": b"<x/>"},
    NPX: {"primary_doc.xml": b"<edgarSubmission><headerData><submissionType>N-PX</submissionType></headerData></edgarSubmission>",
          "proxytable.xml": NPX_XML.encode()},
    TENQ: {"fixture-10q.htm": TENQ_HTML.encode()},
    FUTURE_8K: {"future.htm": b"<p>Item 8.01. Other Events.</p><p>Future text.</p>"},
}

COMPANYFACTS = {"facts": {"us-gaap": {
    "Revenues": {"units": {"USD": [
        {"start": "2025-04-28", "end": "2025-07-27", "val": 46743000000, "accn": TENQ, "fy": 2027, "fp": "Q2", "form": "10-Q", "filed": "2026-08-26"},
        {"start": "2026-01-26", "end": "2026-07-26", "val": 177837000000, "accn": TENQ, "fy": 2027, "fp": "Q2", "form": "10-Q", "filed": "2026-08-26"},
        {"start": "2026-04-27", "end": "2026-07-26", "val": 96221000000, "accn": TENQ, "fy": 2027, "fp": "Q2", "form": "10-Q", "filed": "2026-08-26"},
    ]}},
    "CashAndCashEquivalentsAtCarryingValue": {"units": {"USD": [
        {"end": "2026-07-26", "val": 22443000000, "accn": TENQ, "fy": 2027, "fp": "Q2", "form": "10-Q", "filed": "2026-08-26"},
    ]}},
}}}


class FakeSec:
    """Implements the SecClient surface the check uses. Records every request."""
    archive_base = staticmethod(SecClient.archive_base)

    def __init__(self, fail: set[str] | None = None, files: dict | None = None):
        self.fail = fail or set()
        self.files = json.loads(json.dumps({a: {n: v.decode() for n, v in f.items()} for a, f in (files or FILES).items()}))
        self.requests: list[str] = []

    def _accession(self, url):
        for accession in FILES:
            if accession.replace("-", "") in url:
                return accession
        return None

    def submissions(self, cik):
        self.requests.append("submissions")
        return SUBMISSIONS

    def companyfacts(self, cik):
        self.requests.append("companyfacts")
        return COMPANYFACTS

    def filing_header(self, cik, accession):
        self.requests.append(f"header:{accession}")
        if accession in self.fail:
            raise SecFetchError("https://www.sec.gov/fixture", "http_503", 3)
        stamp, form = HEADERS[accession]
        return "hdr", f"<ACCEPTANCE-DATETIME>{stamp}\nCONFORMED SUBMISSION TYPE:\t{form}\nCOMPANY CONFORMED NAME:\t\t\tNVIDIA CORP\n"

    def filing_index(self, cik, accession):
        self.requests.append(f"index:{accession}")
        names = list(self.files[accession]) + ["FilingSummary.xml", f"{accession}-index.html"]
        return "idx", {"directory": {"item": [{"name": n} for n in names]}}

    def fetch(self, url):
        accession = self._accession(url)
        name = url.rsplit("/", 1)[-1]
        self.requests.append(f"fetch:{accession}:{name}")
        return self.files[accession][name].encode(), "2026-10-18T00:00:00+00:00"


TRIAGE = {
    NPX: {"classification": "irrelevant", "watch_item_answers": [], "uncertain_watch_item_ids": [], "driver_context": [],
          "rationale": "Proxy voting record only."},
    EVENT_8K: {"classification": "watch_item_evidence",
               "watch_item_answers": [
                   {"watch_item_id": "W3.1", "answers": "Discloses customer workload migration.",
                    "exact_quote": "Two large customers began migrating training workloads to alternative accelerators during the quarter."},
                   {"watch_item_id": "W5.1", "answers": "Discloses a licensing constraint that stopped China sales.",
                    "exact_quote": "Export of FixtureCo accelerators to customers in China now requires a license, and sales there have stopped."}],
               "uncertain_watch_item_ids": [], "driver_context": [],
               "rationale": "Reported migration and a China licensing constraint answer W3.1 and W5.1."},
}

# SYNTHETIC leakage case: the same "China" word, but about where models come from, not NVIDIA's China sales.
CHINA_ORIGIN_MODELS = "Many popular open models originated in China, and restrictions on such models could affect the ExampleHub platform."
LEAKY_TRIAGE = {"classification": "watch_item_evidence",
                "watch_item_answers": [{"watch_item_id": "W5.1", "answers": "China-related restriction risk.",
                                        "exact_quote": CHINA_ORIGIN_MODELS}],
                "uncertain_watch_item_ids": [], "driver_context": [],
                "rationale": "Mentions China and restrictions."}

ASSESSMENT = {
    "relevant": True, "relation": "unresolved", "materiality": "low",
    "reasoning": "A pending acquisition; nothing reported changes adoption or access yet.",
    "observed_facts": [{"statement": "Agreement to acquire ExampleHub.",
                        "exact_quote": "entered into a definitive agreement to acquire ExampleHub, Inc. for approximately $11.9 billion."}],
    "driver_impacts": [{"driver_id": "D3", "relation": "unresolved", "materiality": "low",
                        "reasoning": "Ecosystem expansion, not adoption evidence.",
                        "exact_quote": "FixtureCo commits to keep the platform open and to support other silicon vendors."}],
    "what_changed": ["A pending acquisition was announced."],
    "counter_reading": "The acquisition may signal a need to defend the ecosystem.",
    "uncertainties": ["Closing and regulatory approval are not established."],
    "proposed_change": {"action": "hold_unresolved", "revised_statement": None, "reason": "Pending transaction."},
    "what_to_watch": ["Next 10-Q risk factors."],
}


class ScriptedTransport:
    """SYNTHETIC model fixture: returns scripted JSON, builds the real request so hashes are exercised."""
    executor = "synthetic_fixture"

    def __init__(self, triage=None, assessment=None, fail_stage: str | None = None):
        self.triage = triage or TRIAGE
        self.assessment = assessment or ASSESSMENT
        self.fail_stage = fail_stage
        self.calls: list[tuple[str, str]] = []

    def run(self, stage, context, standing=None):
        from living_thesis.evidence_check import CheckError, build_model_request
        request = build_model_request(stage, context, standing)
        accession = context["event"]["event_id"].split(":", 1)[1]
        self.calls.append((stage, accession))
        if self.fail_stage == stage:
            raise CheckError("model_unavailable", "fixture: no model")
        content = self.triage[accession] if stage == "triage" else self.assessment
        return {"content": json.dumps(content), "prompt_sha256": request["prompt_sha256"],
                "context_sha256": request["context_sha256"],
                "meta": {"executor": self.executor, "requested_model": "fixture", "response_model": "fixture",
                         "usage": {"prompt_tokens": 10, "completion_tokens": 5}, "latency_ms": 1, "finish_reason": "stop"}}
