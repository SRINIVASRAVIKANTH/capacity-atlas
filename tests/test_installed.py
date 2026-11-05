"""Solar already built (NYSERDA): reading, checks, totals per ZIP and per feeder, and the files.

The sample in tests/fixtures/installed_sample.psv is 16 real rows from data.ny.gov (dataset
wgsj-jt5f, data through 2026-08-31), picked to include the odd cases the checks look for.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import pytest

from capacity_atlas.collectors import ArcGISRestCollector, SodaCollector, SodaError
from capacity_atlas.history import FeederHistory
from capacity_atlas.installed import (
    COLUMNS, InstalledSolarError, build, fetch_zip_points, our_feeders, prepare, quality_report,
    zip_points,
)

SAMPLE = Path(__file__).parent / "fixtures" / "installed_sample.psv"
PLACED = ["12601", "12571", "12477", "11374", "10956", "11234", "11720", "12928"]  # not 11690
WHEN = datetime(2026, 10, 29, tzinfo=timezone.utc)


def sample() -> pd.DataFrame:
    return pd.read_csv(SAMPLE, sep="|", dtype=str, keep_default_na=False).astype("string")


def points(codes=PLACED) -> pd.DataFrame:
    records = pd.DataFrame({"ZCTA5": codes, "INTPTLAT": [f"+{41 + i / 10:.7f}" for i in range(len(codes))],
                            "INTPTLON": [f"-{73.5 + i / 10:09.7f}" for i in range(len(codes))]})
    return zip_points(records)


@pytest.fixture(scope="module")
def built():
    return build(sample(), points(), {"central_hudson_ny_pv": {"6011", "6065", "9999"}}, generated=WHEN)


def checks(summary) -> dict:
    return {c["rule_id"]: c for c in summary["checks"]}


# ---------- reading ----------
def test_text_values_become_types_and_bad_values_become_empty():
    raw = sample()
    raw.loc[0, "pv_system_size_kwac"] = "-3"
    raw.loc[1, "interconnection_date"] = "not a date"
    raw.loc[2, "number_of_projects"] = ""
    df = prepare(raw)
    assert pd.isna(df.loc[0, "kw"])           # zero or less is left out of the MW totals
    assert pd.isna(df.loc[1, "date"])
    assert df.loc[2, "systems"] == 1           # a row is at least one system
    assert pd.isna(df.loc[9, "metering"])      # blank text is empty, not ""
    assert df["through"].max() == pd.Timestamp("2026-08-31")


def test_a_renamed_column_stops_the_run_with_a_clear_message():
    with pytest.raises(InstalledSolarError, match="circuit_id"):
        prepare(sample().drop(columns="circuit_id"))


def test_census_points_are_cleaned():
    pts = zip_points(pd.DataFrame({"ZCTA5": ["12601", "12601", "99999", "12477"],
                                   "INTPTLAT": ["+41.7", "+41.7", "+21.3", "bad"],
                                   "INTPTLON": ["-073.9", "-073.9", "-157.8", "-74.0"]}))
    assert list(pts.index) == ["12601"]        # duplicates, places far from New York and bad numbers go
    assert pts.loc["12601"].tolist() == [41.7, -73.9]


# ---------- checks ----------
def test_checks_find_the_real_problems_in_the_sample(built):
    c = checks(built.summary)
    expected = {"no_size": 1, "no_date": 0, "date_after_through": 0, "bad_zip": 2, "zip_outside_ny": 0,
                "county_outside_ny": 1, "no_circuit": 1, "no_metering": 1, "duplicate_project_id": 2,
                "zip_not_mapped": 1}
    assert {k: c[k]["flagged"] for k in expected} == expected
    assert c["county_outside_ny"]["example_ids"] == ["8/21/2515"]   # listed in Bennington County, Vermont
    assert c["duplicate_project_id"]["kw"] == 333.1
    assert all(x["status"] == "ran" for x in built.summary["checks"])
    assert [x["severity"] for x in built.summary["checks"]] == sorted(
        (x["severity"] for x in built.summary["checks"]), key=["error", "warning", "info"].index)


def test_a_zip_from_another_state_and_a_future_date_are_flagged():
    raw = sample()
    raw.loc[0, "zip"] = "07030"                  # Hoboken, New Jersey
    raw.loc[1, "interconnection_date"] = "2026-09-15"
    built = build(raw, points(), generated=WHEN)
    c = checks(built.summary)
    assert c["zip_outside_ny"]["flagged"] == 1 and c["date_after_through"]["flagged"] == 1


# ---------- totals ----------
def test_state_totals(built):
    s = built.summary
    assert s["data_through"] == "2026-08-31" and s["rows"] == 16
    assert s["totals"] == {"systems": 16, "kw": 1419.3, "storage_kw": 0.0, "community_systems": 2,
                           "community_kw": 999.0, "zips": 8}
    assert s["last_12_months"] == {"systems": 9, "kw": 571.7}
    assert s["unplaced"] == {"systems": 3, "kw": 14.5}           # two bad ZIP codes and one without a Census area
    assert s["by_year"][0] == {"year": 2008, "systems": 1, "kw": 6.0}
    assert sum(y["systems"] for y in s["by_year"]) == 16
    assert s["by_utility"][0]["name"] == "Central Hudson"           # largest first
    assert s["source"]["url"] == "https://data.ny.gov/d/wgsj-jt5f"


def test_one_point_per_zip_with_its_totals(built):
    features = {f["properties"]["zip"]: f for f in built.zips["features"]}
    assert sorted(features) == sorted(PLACED)
    p = features["12601"]["properties"]
    assert p == {"zip": "12601", "place": "Poughkeepsie", "county": "Dutchess", "u": "Central Hudson", "kw": 50.6,
                 "n": 6, "cn": 0, "st": 0.0, "r12": 50.6, "last": "2026-08"}
    assert features["11720"]["properties"]["u"] == "PSEGLI"   # utility names are not recased
    old = features["12477"]["properties"]
    assert old["cn"] == 1 and old["r12"] == 0.0 and old["last"] == "2024-02"
    assert features["12601"]["geometry"] == {"type": "Point", "coordinates": [-73.5, 41.0]}


def test_solar_connected_by_the_end_of_each_year(built):
    y = built.years
    assert y["years"] == list(range(2008, 2027)) and y["data_through"] == "2026-08-31"
    assert len(y["state"]) == len(y["years"]) and y["state"] == sorted(y["state"])      # cumulative, never falls
    assert y["state"][0] == 6                                                          # the 2008 project, 6 kW
    assert y["state"][-1] == 1419                                                      # every dated, sized project
    assert sorted(y["zips"]) == sorted(PLACED)                                        # only ZIP codes on the map
    assert all(len(v) == len(y["years"]) for v in y["zips"].values())
    at = dict(zip(y["years"], y["zips"]["12601"], strict=True))
    assert at[2025] == 0 and at[2026] == 51                                            # all six projects came in 2026
    old = dict(zip(y["years"], y["zips"]["10956"], strict=True))
    assert old[2015] == 0 and old[2016] == 133 and old[2026] == 133                   # one project in Dec 2016
    assert y["zips"]["12928"] == [0] * len(y["years"])                                # no size published
    assert y["undated_kw"] == 0.0


def test_the_time_lapse_leaves_out_undated_and_future_rows():
    from capacity_atlas.installed import by_zip_year, prepare
    raw = sample()
    raw.loc[0, "interconnection_date"] = ""            # 4.18 kW with no date
    raw.loc[1, "interconnection_date"] = "2027-01-05"  # 3.04 kW after the data-through date
    df = prepare(raw)
    zips = {"features": [{"properties": {"zip": "12601"}}]}
    y = by_zip_year(df, zips, pd.Timestamp("2026-08-31"))
    assert y["undated_kw"] == 7.2 and y["zips"]["12601"][-1] == 43                   # 50.6 - 4.18 - 3.04
    empty = by_zip_year(df.iloc[0:0], zips, pd.Timestamp("2026-08-31"))
    assert empty["years"] == [] and empty["zips"] == {}


def test_feeders_use_the_exact_circuit_id_and_only_our_utilities(built):
    ch = built.feeders["central_hudson_ny_pv"]
    assert ch["6011"] == [4.2, 1, "2026-08"] and ch["7054"] == [499.0, 1, "2026-03"]
    assert len(ch) == 8
    assert built.feeders["national_grid_ny_pv"]["36_41_24951"] == [0.0, 1, "2024-12"]   # size not published
    assert set(built.feeders) == {"central_hudson_ny_pv", "national_grid_ny_pv"}         # no Con Ed, PSEG LI
    match = built.summary["feeders"]["central_hudson_ny_pv"]
    assert match["feeders_with_capacity"] == 3 and match["feeders_with_solar"] == 2 and match["kw_matched"] == 7.2


def test_place_names_ignore_capitals_and_ties_are_stable():
    from capacity_atlas.installed import _most_common
    assert _most_common(pd.Series(["NEW CITY", "New City", "Nanuet"], dtype="string")) == "New City"
    assert _most_common(pd.Series(["Rye", "Harrison"], dtype="string")) == "Harrison"
    assert _most_common(pd.Series([None], dtype="string")) is None
    # A short form and its full name are one place.
    assert _most_common(pd.Series(["E HAMPTON", "East Hampton", "Sag Harbor"], dtype="string")) == "East Hampton"


@pytest.mark.parametrize("raw, name", [
    ("E Hampton", "East Hampton"), ("W Babylon", "West Babylon"), ("N Babylon", "North Babylon"), ("S Cairo", "South Cairo"),
    ("Wappingrs Fls", "Wappingers Falls"), ("Pt Jeffersn", "Port Jefferson"), ("Pt Jeff Sta", "Port Jefferson Station"),
    ("Pt Wash", "Port Washington"), ("Pt Lookout", "Point Lookout"), ("Rocky Pt", "Rocky Point"), ("Rockvle Ctr", "Rockville Centre"),
    ("Guilderland Ctr", "Guilderland Center"), ("New Hyde Pk", "New Hyde Park"), ("Mt Sinai", "Mount Sinai"), ("Middle Is", "Middle Island"),
    ("Thousand Isl Park", "Thousand Island Park"), ("C Moriches", "Center Moriches"), ("C Sprng Hbr", "Cold Spring Harbor"),
    ("O Westbury", "Old Westbury"), ("Valley Strm", "Valley Stream"), ("Whampt Bch", "Westhampton Beach"), ("Olive Brdg", "Olivebridge"),
    ("Cornwall-Hdsn", "Cornwall-on-Hudson"), ("Mc Lean", "McLean"), ("St James", "Saint James"), ("North pitcher", "North Pitcher"),
    ("Greenvl", "Greenville"), ("Rensselaervl", "Rensselaerville"), ("Stormvl", "Stormville"), ("Brightwtrs", "Brightwaters"),
    ("Farmngville", "Farmingville"), ("Hampt Bays", "Hampton Bays"), ("Islip Terr", "Islip Terrace"), ("Preston Holw", "Preston Hollow"),
    ("Clinton Cors", "Clinton Corners"), ("Annandale On Hudson", "Annandale-on-Hudson"), ("Mcgraw", "McGraw"),
    ("PAUL SMITH'S", "Paul Smiths"), ("Paul Smith'S", "Paul Smiths"), ("CROTON-ON-HUDSON", "Croton-on-Hudson"), ("NEW CITY", "New City"), ("  Rye  ", "Rye"),
    # names that are already right stay as they are
    ("East Hampton", "East Hampton"), ("Fort Ann", "Fort Ann"), ("Van Buren Point", "Van Buren Point"), ("Penn Yan", "Penn Yan"),
    ("Upper Jay", "Upper Jay"), ("Saint Albans", "Saint Albans"), ("De Kalb Junction", "De Kalb Junction"), ("S", "S"),
])
def test_place_names_spell_out_postal_short_forms(raw, name):
    from capacity_atlas.installed import place_name
    assert place_name(raw) == name


def test_our_feeders_are_the_ones_with_a_value_on_the_latest_date(tmp_path):
    h = FeederHistory()
    h.add("central_hudson_ny_pv", "2026-10-19", {"1002": 3.0, "1003": 2.0})
    h.add("central_hudson_ny_pv", "2026-10-26", {"1002": 3.0})
    path = h.save(tmp_path / "h.json")
    assert our_feeders(path) == {"central_hudson_ny_pv": {"1002"}}
    assert our_feeders(None) == {}


# ---------- files ----------
def test_files_for_the_website_and_the_report(built, tmp_path):
    paths = built.write(tmp_path / "tiles", tmp_path / "report")
    names = sorted(p.name for p in paths)
    assert names == ["quality.md", "solar_feeders.json", "solar_summary.json", "solar_years.json", "solar_zips.geojson"]
    years = json.loads((tmp_path / "tiles" / "solar_years.json").read_text(encoding="utf-8"))
    assert years["years"][0] == 2008 and years["years"][-1] == 2026
    feeders = json.loads((tmp_path / "tiles" / "solar_feeders.json").read_text(encoding="utf-8"))
    assert feeders["data_through"] == "2026-08-31" and "central_hudson_ny_pv" in feeders["sources"]
    report = (tmp_path / "report" / "quality.md").read_text(encoding="utf-8")
    assert "Data through: 2026-08-31" in report and "County is not a New York county" in report
    assert "2026-10-29" not in report   # no run date: the file changes only when the data does
    assert "—" not in report


def test_report_wording_is_stable():
    first = quality_report(build(sample(), points(), generated=WHEN).summary)
    later = quality_report(build(sample(), points(), generated=datetime(2027, 1, 1, tzinfo=timezone.utc)).summary)
    assert first == later


# ---------- downloading (fake servers, no network) ----------
class FakeResponse:
    def __init__(self, payload, status=200):
        self._payload, self.status_code, self.text = payload, status, json.dumps(payload)

    def json(self):
        return self._payload

    def raise_for_status(self):
        pass


class FakePortal:
    def __init__(self, rows, error=None):
        self.rows, self.error, self.calls = rows, error, []

    def get(self, url, params, timeout):
        self.calls.append(params)
        if self.error:
            return FakeResponse(self.error, 400)
        start = params["$offset"]
        return FakeResponse(self.rows[start:start + params["$limit"]])


def test_portal_rows_are_paged_until_a_short_page():
    rows = [{"project_id": str(i), "zip": "12601"} for i in range(25)]   # other columns left out, as Socrata does
    portal = FakePortal(rows)
    df = SodaCollector("https://data.ny.gov", "wgsj-jt5f", page_size=10, session=portal, pause_seconds=0).collect(COLUMNS)
    assert len(df) == 25 and [c["$offset"] for c in portal.calls] == [0, 10, 20]
    assert portal.calls[0]["$order"] == ":id" and list(df.columns) == list(COLUMNS)
    assert df["circuit_id"].isna().all()


def test_portal_errors_are_reported():
    portal = FakePortal([], error={"errorCode": "query.soql.no-such-column", "message": "No such column: zip"})
    with pytest.raises(SodaError, match="No such column"):
        SodaCollector("https://data.ny.gov", "x", session=portal).collect(["zip"])


class FakeTiger:
    """Answers the two ArcGIS calls fetch_records makes: the IDs, then the attributes."""

    def __init__(self):
        self.wheres = []

    def post(self, url, data, timeout):
        if data.get("returnIdsOnly") == "true":
            self.wheres.append(data["where"])
            codes = [c.strip("'") for c in data["where"][len("ZCTA5 IN ("):-1].split(",")]
            return FakeResponse({"objectIds": [int(c) for c in codes]})
        ids = data["objectIds"].split(",")
        return FakeResponse({"features": [{"attributes": {"ZCTA5": i, "INTPTLAT": "+42.0", "INTPTLON": "-074.0"}}
                                          for i in ids]})


def test_zip_points_are_asked_for_in_chunks_and_only_for_real_zip_codes():
    tiger = FakeTiger()
    collector = ArcGISRestCollector("https://example.com/MapServer/7", session=tiger)
    codes = [str(12000 + i) for i in range(5)] + ["1005", "", None, "12000"]
    pts = fetch_zip_points(codes, collector, chunk=2)
    assert len(tiger.wheres) == 3 and sorted(pts.index) == [str(12000 + i) for i in range(5)]


def test_command_line_run_writes_everything(tmp_path, monkeypatch, capsys):
    import sys

    import capacity_atlas.installed as installed
    monkeypatch.setattr(installed, "fetch_rows", lambda: sample())
    monkeypatch.setattr(installed, "fetch_zip_points", lambda codes: points())
    monkeypatch.setattr(sys, "argv", ["installed", "--out", str(tmp_path / "tiles"), "--history", str(tmp_path / "none.json"),
                                      "--report", str(tmp_path / "report")])
    installed.main()
    assert "16 systems, 1.4 MW in 8 ZIP codes" in capsys.readouterr().out
    assert (tmp_path / "tiles" / "solar_zips.geojson").exists() and (tmp_path / "report" / "quality.md").exists()


class TextResponse:
    status_code, text = 502, "<html>Bad gateway</html>"

    def json(self):
        raise ValueError("not json")


def test_portal_pages_that_are_not_json_or_never_end_are_stopped():
    class Broken:
        def get(self, url, params, timeout):
            return TextResponse()
    with pytest.raises(SodaError, match="Bad gateway"):
        SodaCollector("https://data.ny.gov", "x", session=Broken()).collect(["zip"])
    endless = FakePortal([{"zip": "12601"}] * 10)
    with pytest.raises(SodaError, match="more than expected"):
        SodaCollector("https://data.ny.gov", "x", page_size=5, session=endless, pause_seconds=0, max_rows=5).collect(["zip"])
    with pytest.raises(ValueError):
        SodaCollector("https://data.ny.gov", "x", page_size=0)
