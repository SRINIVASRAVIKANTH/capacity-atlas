"""Download every row of a table on a Socrata open data portal (for example data.ny.gov).

Socrata serves each dataset through its SODA API:
    https://<portal>/resource/<dataset id>.json?$select=...&$order=:id&$limit=...&$offset=...

Rows come back in pages. Ordering by the internal row id (:id) keeps the pages stable, so no
row is skipped or repeated while paging. No account or app token is needed for a few requests
a week; a token only raises the rate limit.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Sequence

import pandas as pd
import requests

from capacity_atlas.collectors.arcgis_rest import _build_session
from capacity_atlas.collectors.base import CollectorError

logger = logging.getLogger(__name__)


class SodaError(CollectorError):
    """Raised when the portal returns an error or an unexpected response."""


class SodaCollector:
    """Collects the chosen columns of one Socrata dataset into a DataFrame of text values."""

    def __init__(
        self,
        portal: str,
        dataset_id: str,
        page_size: int = 50000,
        timeout: int = 120,
        session: requests.Session | None = None,
        pause_seconds: float = 0.5,
        max_rows: int = 2_000_000,
    ) -> None:
        if page_size < 1:
            raise ValueError("page_size must be at least 1")
        self.url = f"{portal.rstrip('/')}/resource/{dataset_id}.json"
        self.page_size = page_size
        self.timeout = timeout
        self.session = session or _build_session()
        self.pause_seconds = pause_seconds
        self.max_rows = max_rows  # a guard against paging forever if the portal misbehaves

    def _get(self, params: dict) -> list[dict]:
        response = self.session.get(self.url, params=params, timeout=self.timeout)
        try:
            payload = response.json()
        except ValueError as exc:
            snippet = response.text[:300].strip() or "<empty body>"
            raise SodaError(f"Response was not JSON from {self.url} (HTTP {response.status_code}). "
                            f"Body starts with: {snippet}") from exc
        if isinstance(payload, dict) and (payload.get("error") or payload.get("errorCode")):
            raise SodaError(f"Portal error from {self.url}: {payload.get('message') or payload}")
        if response.status_code >= 400:
            raise SodaError(f"HTTP {response.status_code} from {self.url}")
        if not isinstance(payload, list):
            raise SodaError(f"Expected a list of rows from {self.url}, got {type(payload).__name__}")
        return payload

    def collect(self, columns: Sequence[str]) -> pd.DataFrame:
        """Every row, with exactly these columns (a column the portal left out of a row is empty)."""
        if not columns:
            raise ValueError("choose at least one column")
        rows: list[dict] = []
        offset = 0
        while True:
            if offset and self.pause_seconds:
                time.sleep(self.pause_seconds)  # be polite to the portal
            page = self._get({"$select": ",".join(columns), "$order": ":id",
                              "$limit": self.page_size, "$offset": offset})
            rows.extend(page)
            logger.info("%s: %d rows so far", self.url, len(rows))
            if len(page) < self.page_size:
                break
            offset += self.page_size
            if offset >= self.max_rows:
                raise SodaError(f"Stopped after {offset:,} rows: more than expected from {self.url}")
        # Socrata leaves empty values out of each row, so the frame is built with fixed columns.
        return pd.DataFrame(rows, columns=list(columns)).astype("string")
