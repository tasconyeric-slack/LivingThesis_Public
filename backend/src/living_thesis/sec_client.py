from __future__ import annotations
import hashlib
import time
from datetime import datetime, timezone
import httpx


class SecFetchError(RuntimeError):
    """A bounded SEC request failed. Carries no credentials, only the URL and a reason code."""

    def __init__(self, url: str, reason: str, attempts: int):
        super().__init__(f"{reason} after {attempts} attempt(s): {url}")
        self.url, self.reason, self.attempts = url, reason, attempts


class SecClient:
    BASE_DATA = "https://data.sec.gov"
    BASE_WWW = "https://www.sec.gov"
    RETRY_STATUS = {429, 500, 502, 503, 504}

    def __init__(self, user_agent: str, timeout: float = 30.0, min_interval: float = 0.12,
                 max_attempts: int = 3, backoff: float = 1.0, transport: httpx.BaseTransport | None = None):
        if not user_agent or "@" not in user_agent:
            raise ValueError("SEC_USER_AGENT must identify the app and include a contact email, e.g. 'LivingThesis you@example.com'.")
        self.client = httpx.Client(
            timeout=timeout,
            headers={
                "User-Agent": user_agent,
                "Accept-Encoding": "gzip, deflate",
                "Accept": "application/json,text/html,*/*",
            },
            follow_redirects=True,
            transport=transport,
        )
        self.min_interval = min_interval
        self.max_attempts = max(1, max_attempts)
        self.backoff = backoff
        self._last_request = 0.0
        self.request_log: list[dict] = []

    def _get(self, url: str) -> httpx.Response:
        """Paced GET with bounded retries on transport errors, 429 and 5xx. Other statuses fail at once."""
        reason = "unknown"
        for attempt in range(1, self.max_attempts + 1):
            wait = self.min_interval - (time.monotonic() - self._last_request)
            if wait > 0:
                time.sleep(wait)
            try:
                r = self.client.get(url)
            except httpx.TransportError as exc:
                reason = f"transport_error:{type(exc).__name__}"
            else:
                self._last_request = time.monotonic()
                self.request_log.append({"url": url, "status": r.status_code, "attempt": attempt})
                if r.status_code < 400:
                    return r
                reason = f"http_{r.status_code}"
                if r.status_code not in self.RETRY_STATUS:
                    raise SecFetchError(url, reason, attempt)
            self._last_request = time.monotonic()
            if attempt < self.max_attempts:
                time.sleep(self.backoff * 2 ** (attempt - 1))
        raise SecFetchError(url, reason, self.max_attempts)

    @staticmethod
    def cik10(cik: str | int) -> str:
        return str(cik).zfill(10)

    @staticmethod
    def archive_base(cik: str | int, accession_no: str) -> str:
        return f"{SecClient.BASE_WWW}/Archives/edgar/data/{int(str(cik))}/{accession_no.replace('-', '')}"

    def submissions(self, cik: str | int) -> dict:
        return self._get(f"{self.BASE_DATA}/submissions/CIK{self.cik10(cik)}.json").json()

    def companyfacts(self, cik: str | int) -> dict:
        return self._get(f"{self.BASE_DATA}/api/xbrl/companyfacts/CIK{self.cik10(cik)}.json").json()

    def fetch(self, url: str) -> tuple[bytes, str]:
        """Raw response bytes plus the UTC retrieval time. Checksums are over these bytes."""
        r = self._get(url)
        return r.content, datetime.now(timezone.utc).isoformat()

    def filing_index(self, cik: str | int, accession_no: str) -> tuple[str, dict]:
        url = f"{self.archive_base(cik, accession_no)}/index.json"
        return url, self._get(url).json()

    def filing_header(self, cik: str | int, accession_no: str) -> tuple[str, str]:
        url = f"{self.archive_base(cik, accession_no)}/{accession_no}-index-headers.html"
        return url, self._get(url).text

    def filing_html(self, cik: str | int, accession_no: str, primary_document: str) -> tuple[str, str]:
        url = f"{self.archive_base(cik, accession_no)}/{primary_document}"
        r = self._get(url)
        return url, r.text

    @staticmethod
    def sha256_text(text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()
