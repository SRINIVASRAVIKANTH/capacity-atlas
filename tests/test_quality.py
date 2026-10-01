"""Each rule is tested on a tiny table where we know exactly which rows are bad."""

from datetime import datetime, timezone

import geopandas as gpd
import pandas as pd
from shapely.geometry import LineString

from capacity_atlas.quality import QualityChecker, default_rules
from capacity_atlas.quality.checker import write_reports
from capacity_atlas.schema import ColumnMap
from capacity_atlas.sources import SOURCES

COLUMNS = ColumnMap(
    record_id="OBJECTID", feeder="Feeder", substation="Substation", phases="Phases",
    capacity_min_mw="HCMin", capacity_max_mw="HCMax",
    analysis_date="HCA_REFRESH_DATE", der_added_since_analysis_mw="DG_INST_LASTHCA",
)
REFERENCE = datetime(2026, 9, 30, tzinfo=timezone.utc)
MS = lambda d: int(pd.Timestamp(d, tz="UTC").timestamp() * 1000)  # noqa: E731

A = LineString([(0, 0), (1, 1)])
B = LineString([(2, 2), (3, 3)])


def line(i: int) -> LineString:
    return LineString([(10 + i, 0), (11 + i, 1)])


def make(rows: list[dict]) -> gpd.GeoDataFrame:
    base = {"Feeder": "F1", "Substation": "S1", "Phases": "ABC", "HCMin": 1.0, "HCMax": 2.0,
            "HCA_REFRESH_DATE": MS("2026-08-01"), "DG_INST_LASTHCA": 0.0}
    records, shapes = [], []
    for i, r in enumerate(rows, start=1):
        shapes.append(r.pop("geometry", line(i)))
        records.append({"OBJECTID": i, **base, **r})
    return gpd.GeoDataFrame(records, geometry=shapes, crs="EPSG:4326")


def run(gdf):
    results = QualityChecker(default_rules(COLUMNS, REFERENCE), "OBJECTID").run(gdf)
    return {r.rule_id: r for r in results}


def test_clean_data_passes_every_error_and_warning_rule():
    results = run(make([{}, {}, {}]))
    for r in results.values():
        assert r.status == "ran"
        assert r.flagged == 0, r.rule_id


def test_missing_value_rules():
    gdf = make([
        {"Substation": None},                                   # 1: feeder without substation
        {"Phases": None},                                       # 2: feeder without phase
        {"HCMin": None, "HCMax": None},                         # 3: feeder without capacity
        {"Feeder": None, "HCMin": None, "HCMax": None,
         "Phases": None, "HCA_REFRESH_DATE": None},             # 4: substation without feeder
    ])
    r = run(gdf)
    assert r["feeder_without_substation"].example_ids == [1]
    assert r["feeder_without_phase"].example_ids == [2]
    assert r["feeder_without_capacity"].example_ids == [3]
    assert r["substation_without_feeder"].example_ids == [4]
    assert r["no_analysis_published"].example_ids == [4]


def test_duplicates_and_conflicts():
    gdf = make([
        {"geometry": A, "HCMin": 1.0},
        {"geometry": A, "HCMin": 1.0},   # duplicate, same value: warning only
        {"geometry": B, "HCMin": 1.0},
        {"geometry": B, "HCMin": 3.0},   # duplicate, different value: error
    ])
    r = run(gdf)
    assert r["duplicate_shape"].flagged == 4
    assert r["duplicate_shape_conflicting_capacity"].example_ids == [3, 4]


def test_unanalyzed_duplicates_are_ignored():
    gdf = make([{"geometry": A, "Feeder": None}, {"geometry": A, "Feeder": None}])
    assert run(gdf)["duplicate_shape"].flagged == 0


def test_impossible_values():
    gdf = make([{"HCMin": 5.0, "HCMax": 2.0}, {"HCMin": -1.0}])
    r = run(gdf)
    assert r["capacity_min_above_max"].example_ids == [1]
    assert r["capacity_negative"].example_ids == [2]


def test_stale_analysis_needs_both_age_and_new_der():
    gdf = make([
        {"HCA_REFRESH_DATE": MS("2026-01-01"), "DG_INST_LASTHCA": 0.8},  # old + grew: flag
        {"HCA_REFRESH_DATE": MS("2026-01-01"), "DG_INST_LASTHCA": 0.2},  # old, little growth
        {"HCA_REFRESH_DATE": MS("2026-08-01"), "DG_INST_LASTHCA": 2.0},  # recent
        {"HCA_REFRESH_DATE": None, "DG_INST_LASTHCA": 2.0},              # no date: not judged
    ])
    assert run(gdf)["stale_analysis_with_new_der"].example_ids == [1]


def test_missing_columns_are_skipped_not_crashed():
    gdf = make([{}]).drop(columns=["Phases"])
    assert run(gdf)["feeder_without_phase"].status == "skipped"


def test_reports_are_written(tmp_path):
    snapshot = tmp_path / "2026-09-30.parquet"
    results = QualityChecker(default_rules(COLUMNS, REFERENCE), "OBJECTID").run(make([{"HCMin": -1.0}]))
    json_path, md_path = write_reports(results, snapshot, "test_source")
    assert json_path.name == "2026-09-30.quality.json"
    assert "Capacity value is negative" in md_path.read_text(encoding="utf-8")


def test_every_source_with_columns_builds_rules():
    for source in SOURCES.values():
        if source.columns:
            assert default_rules(source.columns, REFERENCE)
