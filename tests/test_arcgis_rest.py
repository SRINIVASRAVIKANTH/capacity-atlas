"""Tests use a fake server so they run offline and never hit a real utility."""

from datetime import datetime, timezone

import pytest

from capacity_atlas.collectors import ArcGISRestCollector, ArcGISRestError
from capacity_atlas.snapshot import save_snapshot
from capacity_atlas.sources import SOURCES, get_source


def make_feature(object_id: int) -> dict:
    return {
        "type": "Feature",
        "id": object_id,
        "geometry": {"type": "LineString", "coordinates": [[-72.6, 41.7], [-72.5, 41.8]]},
        "properties": {
            "ID": object_id,
            "CIRCUIT_NAME": f"CKT-{object_id}",
            "FEEDER_CAPACITY_TO_MAP_MW": 1.5,
        },
    }


class FakeResponse:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict:
        return self._payload


class FakeSession:
    """Behaves like an ArcGIS server holding a fixed set of object IDs."""

    def __init__(self, object_ids: list[int], error: dict | None = None, drop_one: bool = False):
        self.object_ids = object_ids
        self.error = error
        self.drop_one = drop_one
        self.feature_calls = 0

    def post(self, url: str, data: dict, timeout: int) -> FakeResponse:
        assert url.endswith("/query")
        if self.error:
            return FakeResponse({"error": self.error})
        if data.get("returnIdsOnly") == "true":
            return FakeResponse({"objectIdFieldName": "ID", "objectIds": self.object_ids})
        self.feature_calls += 1
        ids = [int(i) for i in data["objectIds"].split(",")]
        if self.drop_one:
            ids = ids[:-1]
        return FakeResponse({"type": "FeatureCollection", "features": [make_feature(i) for i in ids]})


def test_collects_all_features_in_batches():
    session = FakeSession(object_ids=list(range(1, 1201)))
    gdf = ArcGISRestCollector("https://example.com/MapServer/0", batch_size=500, session=session).collect()
    assert len(gdf) == 1200
    assert session.feature_calls == 3  # 500 + 500 + 200
    assert gdf.crs.to_string() == "EPSG:4326"
    assert "FEEDER_CAPACITY_TO_MAP_MW" in gdf.columns


def test_empty_layer_returns_empty_frame():
    gdf = ArcGISRestCollector("https://example.com/MapServer/0", session=FakeSession([])).collect()
    assert gdf.empty


def test_server_error_inside_200_is_raised():
    session = FakeSession([1], error={"code": 400, "message": "Invalid query"})
    with pytest.raises(ArcGISRestError, match="Invalid query"):
        ArcGISRestCollector("https://example.com/MapServer/0", session=session).collect()


def test_missing_features_are_detected():
    session = FakeSession(list(range(1, 11)), drop_one=True)
    with pytest.raises(ArcGISRestError, match="expected 10"):
        ArcGISRestCollector("https://example.com/MapServer/0", session=session).collect()


def test_invalid_batch_size_rejected():
    with pytest.raises(ValueError):
        ArcGISRestCollector("https://example.com/MapServer/0", batch_size=0)


def test_unknown_source_has_helpful_message():
    with pytest.raises(KeyError, match="Available"):
        get_source("does_not_exist")


def test_snapshot_writes_data_and_metadata(tmp_path):
    session = FakeSession(list(range(1, 6)))
    gdf = ArcGISRestCollector("https://example.com/MapServer/0", session=session).collect()
    when = datetime(2026, 9, 29, tzinfo=timezone.utc)
    path = save_snapshot(gdf, SOURCES["central_hudson_ny_pv"], tmp_path, when)
    assert path.name == "2026-09-29.parquet"
    assert (path.parent / "2026-09-29.meta.json").exists()


def test_negative_pause_rejected():
    with pytest.raises(ValueError):
        ArcGISRestCollector("https://example.com/MapServer/0", pause_seconds=-1)


def test_every_source_batch_size_is_valid():
    for source in SOURCES.values():
        assert 1 <= source.batch_size <= 2000
        assert source.pause_seconds >= 0
