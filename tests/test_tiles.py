"""Tile builder tests. The full tippecanoe build runs only where tippecanoe is installed."""

import shutil

import geopandas as gpd
import pytest
from shapely.geometry import LineString

from capacity_atlas.sources import SOURCES
from capacity_atlas.tiles import (
    TileBuildError,
    build_tiles,
    combine,
    find_tippecanoe,
    latest_snapshot,
    map_features,
)


def central_hudson_like():
    return gpd.GeoDataFrame(
        {"OBJECTID": [1, 2], "Feeder": ["F1", None], "HCMin": [1.234, None]},
        geometry=[LineString([(-74, 41.5), (-74.01, 41.51)]), LineString([(-74.1, 41.6), (-74.2, 41.7)])],
        crs="EPSG:4326",
    )


def national_grid_like():
    return gpd.GeoDataFrame(
        {"OBJECTID": [1], "feeder_cdf": ["NG1"], "primary_hc": [0.5]},
        geometry=[LineString([(-8700000, 5300000), (-8700100, 5300100)])],
        crs="EPSG:3857",  # different projection on purpose
    )


def test_map_features_uses_each_sources_column_names():
    out = map_features(SOURCES["central_hudson_ny_pv"], central_hudson_like())
    assert list(out.columns) == ["src", "feeder", "hc", "geometry"]
    assert out["hc"].iloc[0] == 1.23
    assert out["hc"].isna().iloc[1]
    assert set(out["src"]) == {"central_hudson_ny_pv"}


def test_map_features_reprojects_to_lat_long():
    out = map_features(SOURCES["national_grid_ny_pv"], national_grid_like())
    assert out.crs.to_epsg() == 4326
    x, y = out.geometry.iloc[0].coords[0]
    assert -80 < x < -70 and 40 < y < 46


def test_empty_geometries_are_dropped():
    gdf = central_hudson_like()
    gdf.loc[1, "geometry"] = LineString()
    assert len(map_features(SOURCES["central_hudson_ny_pv"], gdf)) == 1


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


def test_combine_with_nothing_is_a_clear_error():
    with pytest.raises(TileBuildError, match="No snapshots"):
        combine({})


def test_missing_tippecanoe_is_a_clear_error(tmp_path):
    with pytest.raises(TileBuildError, match="tippecanoe was not found"):
        find_tippecanoe(str(tmp_path / "does-not-exist"))


@pytest.mark.skipif(shutil.which("tippecanoe") is None, reason="tippecanoe not installed here")
def test_full_build_produces_a_pmtiles_file(tmp_path):
    ch, ng = tmp_path / "ch.parquet", tmp_path / "ng.parquet"
    central_hudson_like().to_parquet(ch)
    national_grid_like().to_parquet(ng)
    features = combine({"central_hudson_ny_pv": ch, "national_grid_ny_pv": ng})
    out = build_tiles(features, tmp_path / "tiles" / "atlas.pmtiles", find_tippecanoe())
    assert out.stat().st_size > 0
    assert out.read_bytes()[:7] == b"PMTiles"
