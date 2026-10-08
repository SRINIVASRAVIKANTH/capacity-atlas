"""Map data tests. The full tippecanoe build runs only where tippecanoe is installed."""

import json
import shutil
from datetime import datetime, timezone

import geopandas as gpd
import pytest
from shapely.geometry import LineString

from capacity_atlas.sources import SOURCES
from capacity_atlas.tiles import (
    FLAG_BIT,
    FLAG_IDS,
    TileBuildError,
    build_tiles,
    combine,
    find_tippecanoe,
    flag_legend,
    latest_snapshot,
    map_features,
    snapshot_date,
    write_summary,
)

REFERENCE = datetime(2026, 10, 8, tzinfo=timezone.utc)
APRIL_1 = 1775001600000  # 2026-04-01 in milliseconds since 1970


def central_hudson_like():
    return gpd.GeoDataFrame(
        {
            "OBJECTID": [1, 2, 3],
            "Name": ["S1", "S2", "S3"],
            "Feeder": ["F1", "F1", None],
            "Substation": ["SUB A", None, None],          # row 2: feeder without substation
            "Phases": ["ABC", "A", None],
            "Voltage_kV": [13.2, 13.2, None],
            "HCMin": [1.234, 0.0, None],
            "HCMax": [2.0, 0.5, None],
            "HCA_REFRESH_DATE": [APRIL_1, APRIL_1, None],
            "DG_INST_LASTHCA": [0.8, 0.0, None],          # row 1: stale analysis with new DER
        },
        geometry=[
            LineString([(-74, 41.5), (-74.01, 41.51)]),
            LineString([(-74.1, 41.6), (-74.2, 41.7)]),
            LineString([(-74.3, 41.6), (-74.4, 41.7)]),
        ],
        crs="EPSG:4326",
    )


def national_grid_like():
    return gpd.GeoDataFrame(
        {
            "OBJECTID": [1], "ID": ["X1"], "feeder_cdf": ["NG1"], "primary_hc": [0.5],
            "primary_voltage": [13.2], "color": ["yellow"],
            "primary_hc_over_voltage": [0.5], "primary_hc_voltage_deviation": [3.0],
            "primary_hc_regulator_deviation": [3.0], "primary_hc_thermal_from_gen": [3.0],
            "primary_hc_anti_islanding": [3.0], "primary_hc_flicker": [3.0],
        },
        geometry=[LineString([(-8700000, 5300000), (-8700100, 5300100)])],
        crs="EPSG:3857",  # different projection on purpose
    )


def test_map_features_shared_fields_and_flags():
    out, summary = map_features(SOURCES["central_hudson_ny_pv"], central_hudson_like(), REFERENCE)
    assert {"src", "feeder", "hc", "q", "sub", "ph", "kv", "ad", "geometry"} <= set(out.columns)
    assert out["hc"].iloc[0] == 1.23
    assert out["ad"].iloc[0] == "2026-04-01"
    assert out["q"].iloc[0] & FLAG_BIT["stale_analysis_with_new_der"]
    assert out["q"].iloc[1] & FLAG_BIT["feeder_without_substation"]
    assert not out["q"].iloc[0] & FLAG_BIT["feeder_without_substation"]
    assert out["q"].iloc[2] == 0  # unanalyzed line: no data, but nothing contradictory either
    assert list(out["qs"]) == [1, 1, 0]  # warnings on rows 1 and 2, nothing on row 3

    assert (summary.sections, summary.analyzed, summary.zero_mw) == (3, 2, 1)
    checks = {c["id"]: c for c in summary.checks}
    assert checks["feeder_without_substation"]["flagged"] == 1
    assert checks["feeder_without_substation"]["feeders"] == 1


def test_national_grid_is_reprojected_and_has_no_central_hudson_fields():
    out, summary = map_features(SOURCES["national_grid_ny_pv"], national_grid_like(), REFERENCE)
    assert out.crs.to_epsg() == 4326
    x, y = out.geometry.iloc[0].coords[0]
    assert -80 < x < -70 and 40 < y < 46
    assert "sub" not in out.columns and "ad" not in out.columns
    assert out["kv"].iloc[0] == 13.2
    assert out["q"].iloc[0] == 0  # colors and limits are consistent in this row
    assert out["qs"].iloc[0] == 0


def test_empty_geometries_are_dropped():
    gdf = central_hudson_like()
    gdf.loc[1, "geometry"] = LineString()
    out, _ = map_features(SOURCES["central_hudson_ny_pv"], gdf, REFERENCE)
    assert len(out) == 2


def test_flag_bits_are_unique_and_documented():
    assert len(set(FLAG_BIT.values())) == len(FLAG_IDS)
    documented = {f["id"] for f in flag_legend()}
    assert documented == set(FLAG_IDS)


def test_snapshot_date_from_both_name_styles(tmp_path):
    assert snapshot_date(tmp_path / "2026-10-08.parquet").date().isoformat() == "2026-10-08"
    assert snapshot_date(tmp_path / "national_grid_ny_pv_2026-10-05.parquet").day == 5
    with pytest.raises(TileBuildError, match="Cannot read a date"):
        snapshot_date(tmp_path / "latest.parquet")


def test_latest_snapshot_prefers_this_run_then_newest_release(tmp_path):
    data, previous = tmp_path / "data", tmp_path / "previous"
    (data / "central_hudson_ny_pv").mkdir(parents=True)
    previous.mkdir()
    (previous / "central_hudson_ny_pv_2026-10-05.parquet").touch()
    (previous / "central_hudson_ny_pv_2026-09-28.parquet").touch()
    assert latest_snapshot("central_hudson_ny_pv", data, previous).name == "central_hudson_ny_pv_2026-10-05.parquet"

    (data / "central_hudson_ny_pv" / "2026-10-12.parquet").touch()
    assert latest_snapshot("central_hudson_ny_pv", data, previous).name == "2026-10-12.parquet"
    assert latest_snapshot("national_grid_ny_pv", data, previous) is None


def test_combine_and_summary_file(tmp_path):
    ch, ng = tmp_path / "2026-10-08.parquet", tmp_path / "national_grid_ny_pv_2026-10-08.parquet"
    central_hudson_like().to_parquet(ch)
    national_grid_like().to_parquet(ng)
    features, summaries = combine({"central_hudson_ny_pv": ch, "national_grid_ny_pv": ng})
    assert len(features) == 4 and features.crs.to_epsg() == 4326

    path = write_summary(summaries, tmp_path / "summary.json", REFERENCE)
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["generated_utc"] == "2026-10-08T00:00:00Z"
    assert [s["source_id"] for s in data["sources"]] == ["central_hudson_ny_pv", "national_grid_ny_pv"]
    assert {f["id"] for f in data["flags"]} == set(FLAG_IDS)


def test_combine_with_nothing_is_a_clear_error():
    with pytest.raises(TileBuildError, match="No snapshots"):
        combine({})


def test_missing_tippecanoe_is_a_clear_error(tmp_path):
    with pytest.raises(TileBuildError, match="tippecanoe was not found"):
        find_tippecanoe(str(tmp_path / "does-not-exist"))


@pytest.mark.skipif(shutil.which("tippecanoe") is None, reason="tippecanoe not installed here")
def test_full_build_produces_a_pmtiles_file(tmp_path):
    ch, ng = tmp_path / "2026-10-08.parquet", tmp_path / "national_grid_ny_pv_2026-10-08.parquet"
    central_hudson_like().to_parquet(ch)
    national_grid_like().to_parquet(ng)
    features, _ = combine({"central_hudson_ny_pv": ch, "national_grid_ny_pv": ng})
    out = build_tiles(features, tmp_path / "tiles" / "atlas.pmtiles", find_tippecanoe())
    assert out.read_bytes()[:7] == b"PMTiles"
