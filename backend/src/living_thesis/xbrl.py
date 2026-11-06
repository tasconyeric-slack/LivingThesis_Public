"""SEC companyfacts observations with sourced period identity.

companyfacts stamps every row of a filing with that *filing's* fiscal focus (`fy`/`fp`), so a
prior-year comparative inside a Q2 FY2027 10-Q also carries fy=2027, fp=Q2. A fiscal label is
therefore attached to an observation only when its period ends on the filing's own reporting
date; comparatives stay unresolved instead of being given a guessed label. Fiscal periods are
never derived from calendar dates.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any

from .models import Evidence, Fact, Locator

STANDARD_METRICS = {
    "revenue": ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues"],
    "gross_profit": ["GrossProfit"],
    "net_income": ["NetIncomeLoss"],
}
PERIODIC_FORMS = {"10-Q", "10-Q/A", "10-K", "10-K/A"}
# Day counts (end - start) for 52/53-week fiscal calendars: 13/14, 26/27, 39/40 and 52/53 weeks.
BASIS_DAYS = {"quarter": (88, 99), "half_year_ytd": (179, 190), "nine_month_ytd": (270, 281), "annual": (361, 372)}
# A fiscal focus only admits the durations it can contain. Q1's quarter is also its year to date.
FOCUS_BASES = {"Q1": {"quarter", "instant"}, "Q2": {"quarter", "half_year_ytd", "instant"},
               "Q3": {"quarter", "nine_month_ytd", "instant"}, "FY": {"annual", "instant"}}


class AmbiguousObservation(ValueError):
    """Two current-period observations share an identity but disagree on value."""


@dataclass(frozen=True)
class XbrlObservation:
    taxonomy: str
    tag: str
    unit: str
    value: str                      # exact decimal string as reported; never rounded
    start: str | None
    end: str
    duration_days: int | None
    basis: str                      # instant | quarter | half_year_ytd | nine_month_ytd | annual | unresolved
    accession: str
    form: str
    filed: str | None
    filing_fiscal_year: int | None  # the filing's DEI focus, not necessarily this observation's
    filing_fiscal_period: str | None
    report_period_end: str
    is_current_period: bool
    fiscal_year: int | None         # set only when the period is the filing's own reporting period
    fiscal_period: str | None
    frame: str | None
    notes: tuple[str, ...] = field(default_factory=tuple)

    def as_dict(self) -> dict[str, Any]:
        out = asdict(self)
        out["notes"] = list(self.notes)
        return out


def _days(start: str | None, end: str) -> int | None:
    if not start:
        return None
    return (date.fromisoformat(end) - date.fromisoformat(start)).days


def classify_basis(start: str | None, end: str) -> str:
    days = _days(start, end)
    if days is None:
        return "instant"
    for basis, (low, high) in BASIS_DAYS.items():
        if low <= days <= high:
            return basis
    return "unresolved"


def _rows(companyfacts: dict, taxonomy: str, tag: str, unit: str) -> list[dict]:
    fact = companyfacts.get("facts", {}).get(taxonomy, {}).get(tag) or {}
    return list(fact.get("units", {}).get(unit, []))


def report_period_end(companyfacts: dict, accession: str, taxonomy: str = "us-gaap") -> str | None:
    """The filing's own period end: the latest period end it reports for any fact.

    Comparatives in a 10-Q/10-K always end earlier than the reporting period. Callers holding the
    EDGAR submissions `reportDate` should pass it instead; it is the authoritative value."""
    ends = {row["end"] for tag in companyfacts.get("facts", {}).get(taxonomy, {}).values()
            for rows in tag.get("units", {}).values() for row in rows
            if row.get("accn") == accession and row.get("end")}
    return max(ends) if ends else None


def observations_for_accession(companyfacts: dict, accession: str, tag: str, unit: str = "USD",
                               taxonomy: str = "us-gaap", period_end: str | None = None) -> list[XbrlObservation]:
    period_end = period_end or report_period_end(companyfacts, accession, taxonomy)
    if not period_end:
        return []
    out = []
    for row in _rows(companyfacts, taxonomy, tag, unit):
        if row.get("accn") != accession or not row.get("end") or "val" not in row:
            continue
        start, end = row.get("start"), row["end"]
        basis, notes = classify_basis(start, end), []
        fy, fp = row.get("fy"), row.get("fp")
        current = end == period_end
        fiscal_year = fiscal_period = None
        if basis == "unresolved":
            notes.append("duration_not_a_reporting_basis")
        elif not current:
            notes.append("comparative_period_fiscal_label_unresolved")
        elif fp not in FOCUS_BASES or not isinstance(fy, int):
            notes.append("filing_fiscal_focus_missing")
        elif basis not in FOCUS_BASES[fp]:
            notes.append("duration_inconsistent_with_fiscal_focus")
        elif row.get("form") not in PERIODIC_FORMS:
            notes.append("not_a_periodic_report")
        else:
            fiscal_year, fiscal_period = fy, fp
        out.append(XbrlObservation(
            taxonomy=taxonomy, tag=tag, unit=unit, value=str(Decimal(str(row["val"]))), start=start, end=end,
            duration_days=_days(start, end), basis=basis, accession=accession, form=row.get("form", ""),
            filed=row.get("filed"), filing_fiscal_year=fy if isinstance(fy, int) else None,
            filing_fiscal_period=fp, report_period_end=period_end, is_current_period=current,
            fiscal_year=fiscal_year, fiscal_period=fiscal_period, frame=row.get("frame"), notes=tuple(notes)))
    return out


def select_current(observations: list[XbrlObservation], basis: str) -> XbrlObservation | None:
    """The single current-period observation for a basis; fail closed on disagreement."""
    hits = [o for o in observations if o.basis == basis and o.fiscal_period is not None]
    if not hits:
        return None
    if len({o.value for o in hits}) > 1 or len({(o.start, o.end) for o in hits}) > 1:
        raise AmbiguousObservation(f"{hits[0].tag} {basis}: conflicting current-period observations")
    return hits[0]


def fiscal_label(observation: XbrlObservation) -> str:
    """Human label for a resolved observation, e.g. 'Q2 FY2027' or 'Q2 FY2027 YTD'."""
    if observation.fiscal_period is None:
        raise ValueError("unresolved fiscal period")
    if observation.fiscal_period == "FY":
        return f"FY{observation.fiscal_year}"
    suffix = " YTD" if observation.basis.endswith("_ytd") else ""
    return f"{observation.fiscal_period} FY{observation.fiscal_year}{suffix}"


def fact_for_accession(companyfacts: dict, accession_no: str, tags: list[str], preferred_unit="USD",
                       period_end: str | None = None) -> tuple[str, XbrlObservation] | None:
    """First tag with a resolved current-period quarter (10-Q) or annual (10-K) duration."""
    for tag in tags:
        observations = [o for o in observations_for_accession(companyfacts, accession_no, tag, preferred_unit,
                                                             period_end=period_end) if o.form in PERIODIC_FORMS]
        if not observations:
            continue
        basis = "annual" if observations[0].form.startswith("10-K") else "quarter"
        hit = select_current(observations, basis)
        if hit:
            return tag, hit
    return None


def xbrl_fact(companyfacts: dict, accession_no: str, metric_id: str, label: str, fact_id: str, evidence_id: str,
              source_id: str, period_end: str | None = None) -> tuple[Evidence, Fact] | None:
    try:
        hit = fact_for_accession(companyfacts, accession_no, STANDARD_METRICS[metric_id], period_end=period_end)
    except AmbiguousObservation:
        return None
    if not hit:
        return None
    tag, obs = hit
    value = float(Decimal(obs.value) / Decimal(1_000_000_000))
    ev = Evidence(
        evidence_id=evidence_id,
        source_id=source_id,
        locator=Locator(kind="xbrl", xbrl_tag=tag, context_ref=f"{obs.start}..{obs.end}"),
        excerpt=f"{label}: {value:.3f} USD bn",
    )
    fact = Fact(
        fact_id=fact_id, fact_kind="financial_metric", metric_id=metric_id, label=label,
        value=value, unit="$bn", period_start=obs.start, period_end=obs.end, fiscal_period=fiscal_label(obs),
        # Identity dimensions are unchanged so cross-source canonical merging keeps working;
        # basis and exact reported value are kept as auditable notes.
        dimensions={"form": obs.form, "fp": obs.filing_fiscal_period or ""},
        validation_notes=[f"xbrl_period_basis:{obs.basis}", f"xbrl_reported_value:{obs.value} {obs.unit}"],
        extraction_method="xbrl",
        evidence_ids=[evidence_id], user_relevance=["headline", "thesis_input"] if metric_id == "revenue" else ["thesis_input"],
    )
    return ev, fact
