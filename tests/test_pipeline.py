"""Pipeline tests use fake collectors, so they never touch a real utility server."""

from datetime import datetime, timezone

import geopandas as gpd
from shapely.geometry import LineString

from capacity_atlas.pipeline import run_all
from capacity_atlas.sources import SOURCES

WHEN = datetime(2026, 10, 5, 10, 0, tzinfo=timezone.utc)


class FakeCollector:
    def __init__(self, gdf=None, fail=False):
        self.gdf = gdf
        self.fail = fail

    def collect(self):
        if self.fail:
            raise ConnectionError("server unreachable")
        return self.gdf


def central_hudson_like() -> gpd.GeoDataFrame:
    return gpd.GeoDataFrame(
        {"OBJECTID": [1, 2], "Feeder": ["F1", "F2"], "Substation": ["S1", None],
         "Phases": ["ABC", "A"], "HCMin": [1.0, 0.0], "HCMax": [2.0, 1.0],
         "HCA_REFRESH_DATE": [None, None], "DG_INST_LASTHCA": [0.0, 0.0]},
        geometry=[LineString([(0, 0), (1, 1)]), LineString([(2, 2), (3, 3)])],
        crs="EPSG:4326",
    )


def test_pipeline_saves_snapshot_and_publishes_reports(tmp_path):
    source = SOURCES["central_hudson_ny_pv"]
    runs = run_all([source], tmp_path / "data", tmp_path / "reports", WHEN,
                   make_collector=lambda s: FakeCollector(central_hudson_like()))
    run = runs[0]
    assert run.ok and run.rows == 2
    assert run.snapshot.name == "2026-10-05.parquet"
    published = tmp_path / "reports" / "central_hudson_ny_pv"
    assert (published / "2026-10-05.meta.json").exists()
    assert (published / "2026-10-05.quality.json").exists()
    assert (published / "2026-10-05.quality.md").exists()
    assert run.warnings >= 1  # the missing substation


def test_one_failing_source_does_not_stop_the_others(tmp_path):
    good, bad = SOURCES["central_hudson_ny_pv"], SOURCES["national_grid_ny_pv"]

    def factory(source):
        if source is bad:
            return FakeCollector(fail=True)
        return FakeCollector(central_hudson_like())

    runs = run_all([bad, good], tmp_path / "data", tmp_path / "reports", WHEN, make_collector=factory)
    by_id = {r.source_id: r for r in runs}
    assert not by_id["national_grid_ny_pv"].ok
    assert "server unreachable" in by_id["national_grid_ny_pv"].message
    assert by_id["central_hudson_ny_pv"].ok

    latest = (tmp_path / "reports" / "LATEST.md").read_text(encoding="utf-8")
    assert "FAILED" in latest and "OK" in latest
