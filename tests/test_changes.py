"""Time machine tests: each kind of change is planted once and must be found exactly once."""

import geopandas as gpd
import pandas as pd
from shapely.geometry import LineString

from capacity_atlas.changes import compare, keyed, write_change_report
from capacity_atlas.schema import ColumnMap

COLUMNS = ColumnMap(record_id="OBJECTID", feeder="Feeder", section_key="Name",
                    capacity_mw="HC", analysis_date="DATE")
MS = lambda d: int(pd.Timestamp(d, tz="UTC").timestamp() * 1000)  # noqa: E731


def line(i):
    return LineString([(i, 0), (i + 1, 1)])


def snapshot(rows):
    base = {"Feeder": "F1", "HC": 1.0, "DATE": MS("2026-04-01"), "Volt": 13.2}
    records = [{"OBJECTID": i, "Name": f"S{i}", **base, **r} for i, r in enumerate(rows)]
    shapes = [r.pop("geometry", line(i)) for i, r in enumerate(records)]
    return gpd.GeoDataFrame(records, geometry=shapes, crs="EPSG:4326")


def run(old, new):
    return compare(old, new, COLUMNS, "test", "old.parquet", "new.parquet")


def test_identical_snapshots_show_no_changes():
    s = snapshot([{}, {}, {}])
    assert not run(s, s.copy()).anything_changed


def test_every_change_type_is_detected_once():
    old = snapshot([{}, {}, {}, {}, {}, {"HC": None}, {"HC": 2.0}, {}])
    new = old.copy()
    new.loc[1, "HC"] = 0.5                        # capacity down
    new.loc[2, "HC"] = 1.5                        # capacity up
    new.loc[3, "geometry"] = line(99)             # shape changed
    new.loc[4, "Volt"] = 34.5                     # other attribute
    new.loc[5, "HC"] = 0.8                        # newly analyzed
    new.loc[6, "HC"] = None                       # analysis removed
    new = new.drop(index=7)                       # removed
    added = snapshot([{}]).assign(Name="S_NEW")
    new = gpd.GeoDataFrame(pd.concat([new, added], ignore_index=True), crs=old.crs)

    r = run(old, new)
    assert (r.added, r.removed, r.geometry_changed) == (1, 1, 1)
    assert (r.capacity_increased, r.capacity_decreased) == (1, 1)
    assert (r.newly_analyzed, r.analysis_removed) == (1, 1)
    assert r.other_attributes_changed == 1 and r.most_changed_columns == {"Volt": 1}
    assert r.feeders_losing_capacity[0]["feeder"] == "F1"


def test_rounding_noise_is_not_a_change():
    old = snapshot([{"HC": 1.0}])
    new = old.copy()
    new.loc[0, "HC"] = 1.004
    assert not run(old, new).anything_changed


def test_feeder_refresh_counted_per_feeder():
    old = snapshot([{"Feeder": "A"}, {"Feeder": "A"}, {"Feeder": "B"}])
    new = old.copy()
    new.loc[[0, 1], "DATE"] = MS("2026-10-01")
    assert run(old, new).feeders_refreshed == 1


def test_matching_uses_section_id_not_row_number():
    old = snapshot([{}, {}, {}])
    new = old.iloc[::-1].copy()            # same sections, different order
    new["OBJECTID"] = [10, 11, 12]         # renumbered by a republish
    r = run(old, new)
    assert not r.added and not r.removed
    assert r.most_changed_columns == {"OBJECTID": 3}


def test_repeated_section_ids_are_kept_apart():
    s = snapshot([{"Name": "DUP"}, {"Name": "DUP"}, {}])
    assert list(keyed(s, "Name").index) == ["DUP#0", "DUP#1", "S2#0"]
    assert not run(s, s.copy()).anything_changed


def test_change_report_files(tmp_path):
    s = snapshot([{}])
    json_path, md_path = write_change_report(run(s, s.copy()), tmp_path)
    assert json_path.name == "old_to_new.json"
    assert "No changes" in md_path.read_text(encoding="utf-8")


def test_missing_section_id_column_gives_clear_error():
    import pytest
    s = snapshot([{}]).drop(columns=["Name"])
    with pytest.raises(ValueError, match="Section ID column 'Name' is missing"):
        run(s, s.copy())
