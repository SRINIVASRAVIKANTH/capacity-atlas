"""Download every feature from a public ArcGIS REST layer.

Why this is not a single request:
  ArcGIS servers cap how many features one request returns (MaxRecordCount).
  The Eversource layer caps at 1000 and does not support offset pagination,
  so we first ask for all object IDs, then fetch features in small batches.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterator, Sequence

import geopandas as gpd
import pandas as pd
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

logger = logging.getLogger(__name__)

WGS84 = "EPSG:4326"  # Standard latitude/longitude used by web maps.


class ArcGISRestError(RuntimeError):
    """Raised when an ArcGIS server returns an error or an unexpected response."""


def _build_session() -> requests.Session:
    """A session that retries temporary server failures with growing waits."""
    retry = Retry(
        total=4,
        backoff_factor=2,  # waits 2s, 4s, 8s, 16s between retries
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET", "POST"}),
    )
    session = requests.Session()
    session.mount("https://", HTTPAdapter(max_retries=retry))
    session.headers.update({"User-Agent": "capacity-atlas/0.1 (open-source research project)"})
    return session


def _chunks(items: Sequence[int], size: int) -> Iterator[Sequence[int]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


class ArcGISRestCollector:
    """Collects all features of one ArcGIS REST layer into a GeoDataFrame."""

    def __init__(
        self,
        layer_url: str,
        batch_size: int = 500,
        timeout: int = 60,
        session: requests.Session | None = None,
        pause_seconds: float = 0.0,
    ) -> None:
        if batch_size < 1:
            raise ValueError("batch_size must be at least 1")
        if pause_seconds < 0:
            raise ValueError("pause_seconds cannot be negative")
        self.layer_url = layer_url.rstrip("/")
        self.query_url = f"{self.layer_url}/query"
        self.batch_size = batch_size
        self.timeout = timeout
        self.session = session or _build_session()
        self.pause_seconds = pause_seconds

    def _post(self, params: dict) -> dict:
        """Send one query. POST avoids URL length limits on long ID lists."""
        response = self.session.post(self.query_url, data=params, timeout=self.timeout)
        response.raise_for_status()
        try:
            payload = response.json()
        except ValueError as exc:
            snippet = response.text[:300].strip() or "<empty body>"
            raise ArcGISRestError(
                f"Response was not JSON from {self.query_url} "
                f"(HTTP {response.status_code}, "
                f"content-type {response.headers.get('Content-Type', 'unknown')}, "
                f"{len(response.content)} bytes). Body starts with: {snippet}"
            ) from exc

        # ArcGIS often reports errors inside a normal 200 response.
        if "error" in payload:
            raise ArcGISRestError(f"ArcGIS error from {self.query_url}: {payload['error']}")
        return payload

    def fetch_object_ids(self) -> list[int]:
        payload = self._post({"where": "1=1", "returnIdsOnly": "true", "f": "json"})
        object_ids = payload.get("objectIds") or []
        logger.info("Found %d features at %s", len(object_ids), self.layer_url)
        return sorted(object_ids)

    def fetch_features(self, object_ids: Sequence[int]) -> list[dict]:
        payload = self._post(
            {
                "objectIds": ",".join(str(i) for i in object_ids),
                "outFields": "*",
                "returnGeometry": "true",
                "outSR": "4326",  # ask the server to convert to lat/long for us
                "f": "geojson",
            }
        )
        if "features" not in payload:
            raise ArcGISRestError(f"No 'features' key in response from {self.query_url}")
        return payload["features"]

    def collect(self) -> gpd.GeoDataFrame:
        object_ids = self.fetch_object_ids()
        if not object_ids:
            logger.warning("Layer returned zero features: %s", self.layer_url)
            return gpd.GeoDataFrame(geometry=[], crs=WGS84)

        # Convert each batch to a compact table right away instead of holding
        # hundreds of thousands of raw feature dicts in memory until the end.
        frames: list[gpd.GeoDataFrame] = []
        received = 0
        total_batches = -(-len(object_ids) // self.batch_size)  # ceiling division
        for number, batch in enumerate(_chunks(object_ids, self.batch_size), start=1):
            if number > 1 and self.pause_seconds:
                time.sleep(self.pause_seconds)  # be polite to the server
            features = self.fetch_features(batch)
            if len(features) != len(batch):
                raise ArcGISRestError(
                    f"Batch {number}: expected {len(batch)} features but received {len(features)}"
                )
            frames.append(gpd.GeoDataFrame.from_features(features, crs=WGS84))
            received += len(features)
            logger.info("Batch %d/%d done (%d features so far)", number, total_batches, received)

        combined = pd.concat(frames, ignore_index=True)
        return gpd.GeoDataFrame(combined, geometry="geometry", crs=WGS84)
