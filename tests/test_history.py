"""Feeder capacity history: one point per snapshot date, stored compactly, never lost."""

import json

import geopandas as gpd
from shapely.geometry import LineString

from capacity_atlas.history import FeederHistory, compress, expand, highest_by_feeder, update
from capacity_atlas.snapshot import SnapshotStore
from capacity_atlas.sources import SOURCES

NG = SOURCES["national_grid_ny_pv"]


def ng_snapshot(rows):
    """rows: (feeder, capacity) pairs in National Grid's own column names."""
    return gpd.GeoDataFrame(
        {"OBJECTID": range(len(rows)), "ID": [f"X{i}" for i in range(len(rows))],
         "feeder_cdf": [f for f, _ in rows], "primary_hc": [hc for _, hc in rows]},
        geometry=[LineString([(i, 0), (i + 1, 1)]) for i in range(len(rows))], crs="EPSG:4326")


def test_highest_value_per_feeder_and_blank_feeders_skipped():
    frame = ng_snapshot([("A", 1.234), ("A", 4.0), ("B", None), ("", 9.0)])
    assert highest_by_feeder(frame, NG) == {"A": 4.0, "B": None}


def test_change_points_round_trip():
    values = [6.0, 6.0, 4.8, None, None, 4.8]
    assert compress(values) == [[0, 6.0], [2, 4.8], [3, None], [5, 4.8]]
    assert expand(compress(values), 6) == values
    assert compress([]) == []


def test_dates_stay_in_order_when_backfilling_and_a_repeat_date_replaces():
    h = FeederHistory()
    h.add("s", "2026-10-09", {"A": 4.0})
    h.add("s", "2026-10-02", {"A": 6.0, "B": 1.0})   # an older release found later
    h.add("s", "2026-10-09", {"A": 3.5})             # the same date again: replaced, not added
    entry = h.sources["s"]
    assert entry["dates"] == ["2026-10-02", "2026-10-09"]
    assert entry["feeders"] == {"A": [6.0, 3.5], "B": [1.0, None]}


def test_save_and_load_keep_everything(tmp_path):
    h = FeederHistory()
    for day, value in [("2026-10-02", 6.0), ("2026-10-09", 6.0), ("2026-10-16", 4.8)]:
        h.add("s", day, {"A": value})
    path = h.save(tmp_path / "history.json")
    stored = json.loads(path.read_text(encoding="utf-8"))
    assert stored["sources"]["s"]["feeders"]["A"] == [[0, 6.0], [2, 4.8]]   # only the changes
    assert FeederHistory.load(path).sources == h.sources


def test_a_damaged_file_is_ignored_not_fatal(tmp_path):
    for text in ["not json", '{"sources": {"s": {"dates": ["b", "a"], "feeders": {}}}}',
                 '{"sources": {"s": {"dates": ["a"], "feeders": {"A": [[5, 1.0]]}}}}']:
        path = tmp_path / "bad.json"
        path.write_text(text, encoding="utf-8")
        assert FeederHistory.load(path).sources == {}
    assert FeederHistory.load(tmp_path / "missing.json").sources == {}


def test_only_the_newest_dates_are_kept_and_vanished_feeders_leave():
    h = FeederHistory()
    h.add("s", "2026-01-01", {"OLD": 1.0})
    for week in range(2, 6):
        h.add("s", f"2026-01-0{week}", {"NEW": 2.0})
    h.trim("s", keep=3)
    assert h.sources["s"]["dates"] == ["2026-01-03", "2026-01-04", "2026-01-05"]
    assert set(h.sources["s"]["feeders"]) == {"NEW"}


def test_update_adds_each_new_snapshot_once(tmp_path):
    previous = tmp_path / "previous"
    previous.mkdir()
    ng_snapshot([("A", 6.0)]).to_parquet(previous / "national_grid_ny_pv_2026-10-02.parquet")
    run = tmp_path / "snapshots" / "national_grid_ny_pv"
    run.mkdir(parents=True)
    ng_snapshot([("A", 4.8)]).to_parquet(run / "2026-10-09.parquet")
    (previous / "national_grid_ny_pv_damaged_2026-10-05.parquet").write_bytes(b"not parquet")

    h = FeederHistory()
    stores = [SnapshotStore(tmp_path / "snapshots", previous)]
    added = update(h, stores)
    assert added == ["national_grid_ny_pv 2026-10-02", "national_grid_ny_pv 2026-10-09"]  # damaged file skipped
    assert h.sources["national_grid_ny_pv"]["feeders"]["A"] == [6.0, 4.8]
    assert update(h, stores) == []   # nothing new the second time
