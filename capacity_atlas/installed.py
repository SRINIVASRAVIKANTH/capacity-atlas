"""Solar already built: New York's list of connected distributed solar, by ZIP code and by feeder.

Hosting capacity says how much MORE solar a line can take. This module adds the other half of
the picture: how much solar is ALREADY connected. NYSERDA publishes every distributed solar
project connected in New York since 2000 on the state's open data portal ("Statewide Distributed
Solar Projects: Beginning 2000", data.ny.gov dataset wgsj-jt5f). It holds built projects only;
projects still waiting in a utility's queue are not in it. NYSERDA updates it about every
three months, so every output carries its "data through" date.

The OPEN-NY Terms of Use cover it: reuse is allowed without attribution or approval, as long as
the use is lawful. We still name NYSERDA as the source everywhere the numbers appear.

ZIP code locations come from the US Census Bureau's 2020 ZIP Code Tabulation Areas (TIGERweb).
Each ZIP is drawn as one point, the Census "internal point" of its area, which always lies
inside the area. Points sized by the amount of solar read honestly: shading whole ZIP areas by
a total would make large rural ZIPs look like they hold the most solar just because they are big.

Outputs, written next to the map data and uploaded to R2 by the weekly run:

    solar_summary.json   statewide totals, by year, by utility, data quality checks, and how
                         many of each utility's feeders with a published capacity have solar on record
    solar_zips.geojson   one point per ZIP code with its totals, for the "Built so far" page:
                         zip, place, county, u (main utility), kw, n (systems), cn (community
                         solar systems), st (battery kW), r12 (kW connected in the last 12 months),
                         last (latest connection YYYY-MM)
    solar_feeders.json   per utility and feeder: [kW built, systems, latest connection YYYY-MM],
                         for the line cards on the main map

and reports/installed_solar/quality.md, committed to the repository. It changes only when
NYSERDA publishes new data, so git keeps one version per update.

Feeders are matched only where NYSERDA's circuit ID is exactly the feeder ID the utility
publishes in its hosting capacity data. Nothing is guessed.

Usage (the weekly run does this):
    python -m capacity_atlas.installed --out data/tiles \
        --history reports/history/feeder_capacity.json --report reports/installed_solar
"""

from __future__ import annotations

import argparse
import json
import logging
from collections.abc import Callable, Iterable, Sequence
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from capacity_atlas.collectors import ArcGISRestCollector, SodaCollector
from capacity_atlas.history import FeederHistory
from capacity_atlas.quality.checker import QualityChecker, RuleResult
from capacity_atlas.quality.rules import ERROR, INFO, WARNING, QualityRule
from capacity_atlas.snapshot import replace_atomically
from capacity_atlas.sources import SOURCES, Source

logger = logging.getLogger(__name__)

PORTAL = "https://data.ny.gov"
DATASET_ID = "wgsj-jt5f"
DATASET_NAME = "Statewide Distributed Solar Projects: Beginning 2000"
DATASET_PAGE = f"{PORTAL}/d/{DATASET_ID}"
PUBLISHER = "NYSERDA"
COLUMNS = (
    "project_id", "interconnection_date", "data_through_date", "utility", "city_town", "county",
    "zip", "circuit_id", "metering_method", "pv_system_size_kwac", "energy_storage_system_size_kwac",
    "number_of_projects",
)
# 2020 Census ZIP Code Tabulation Areas on the Census Bureau's TIGERweb service.
ZCTA_LAYER = ("https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/"
              "PUMA_TAD_TAZ_UGA_ZCTA/MapServer/7")
ZCTA_FIELDS = ("ZCTA5", "INTPTLAT", "INTPTLON")
COMMUNITY_SOLAR = "CDG"  # community distributed generation, NYSERDA's metering code for community solar

# New York's 62 counties as NYSERDA spells them.
NY_COUNTIES = frozenset(["Albany", "Allegany", "Bronx", "Broome", "Cattaraugus", "Cayuga", "Chautauqua", "Chemung", "Chenango", "Clinton", "Columbia", "Cortland", "Delaware", "Dutchess", "Erie", "Essex", "Franklin", "Fulton", "Genesee", "Greene", "Hamilton", "Herkimer", "Jefferson", "Kings", "Lewis", "Livingston", "Madison", "Monroe", "Montgomery", "Nassau", "Niagara", "Oneida", "Onondaga", "Ontario", "Orange", "Orleans", "Oswego", "Otsego", "Putnam", "Queens", "Rensselaer", "Richmond", "Rockland", "Saratoga", "Schenectady", "Schoharie", "Schuyler", "Seneca", "Steuben", "Suffolk", "Sullivan", "Tioga", "Tompkins", "Ulster", "Warren", "Washington", "Wayne", "Westchester", "Wyoming", "Yates"]) | {"New York", "St Lawrence", "St. Lawrence"}
# ZIP codes used in New York: 100 to 149, plus 005 (Holtsville) and 063 (Fishers Island).
NY_ZIP_PREFIXES = frozenset({"005", "063"} | {str(p) for p in range(100, 150)})


class InstalledSolarError(RuntimeError):
    """Raised when the downloaded data cannot be used at all."""


# ---------- reading the rows ----------
def prepare(raw: pd.DataFrame) -> pd.DataFrame:
    """Typed columns from the portal's text values. Bad values become empty, never errors."""
    missing = [c for c in COLUMNS if c not in raw.columns]
    if missing:
        raise InstalledSolarError(f"The dataset no longer has these columns: {missing}")
    text = lambda c: raw[c].astype("string").str.strip().replace("", pd.NA)  # noqa: E731
    df = pd.DataFrame({
        "project_id": text("project_id"),
        "utility": text("utility"),
        "city": text("city_town"),
        "county": text("county"),
        "zip": text("zip"),
        "circuit": text("circuit_id"),
        "metering": text("metering_method"),
        "kw": pd.to_numeric(raw["pv_system_size_kwac"], errors="coerce"),
        "storage_kw": pd.to_numeric(raw["energy_storage_system_size_kwac"], errors="coerce"),
        # A row can stand for more than one project at the same place; missing means one.
        "systems": pd.to_numeric(raw["number_of_projects"], errors="coerce").fillna(1).clip(lower=1),
        "date": pd.to_datetime(raw["interconnection_date"], errors="coerce").dt.tz_localize(None),
        "through": pd.to_datetime(raw["data_through_date"], errors="coerce").dt.tz_localize(None),
    })
    df["systems"] = df["systems"].astype("int64")
    df.loc[df["kw"] <= 0, "kw"] = pd.NA  # flagged by a check, and left out of the totals
    df["kw"] = df["kw"].astype("Float64")
    return df


def data_through(df: pd.DataFrame) -> pd.Timestamp:
    through = df["through"].max()
    if pd.isna(through):
        raise InstalledSolarError("The dataset has no data-through date")
    return through


def is_zip(values: pd.Series) -> pd.Series:
    return values.fillna("").str.fullmatch(r"\d{5}").astype(bool)


def is_ny_zip(values: pd.Series) -> pd.Series:
    return is_zip(values) & values.fillna("").str[:3].isin(NY_ZIP_PREFIXES)


# ---------- data quality checks ----------
class RowRule(QualityRule):
    """One yes/no question about each row of the prepared table."""

    def __init__(self, rule_id: str, title: str, severity: str, explanation: str,
                 columns: Sequence[str], test: Callable[[pd.DataFrame], pd.Series]) -> None:
        self.rule_id = rule_id
        self.title = title
        self.severity = severity
        self.explanation = explanation
        self.columns = list(columns)
        self.test = test

    def required_columns(self) -> list[str]:
        return self.columns

    def check(self, gdf: pd.DataFrame) -> pd.Series:
        return self.test(gdf).fillna(False).astype(bool)


def default_rules(mapped_zips: Iterable[str] | None = None) -> list[QualityRule]:
    mapped = frozenset(() if mapped_zips is None else mapped_zips)
    rules = [
        RowRule("no_size", "No system size", ERROR,
                "The project has no size, or a size of zero or less. It is counted as a system but adds nothing to the MW totals.",
                ["kw"], lambda d: d["kw"].isna()),
        RowRule("no_date", "No connection date", WARNING,
                "The project has no connection date, so it is missing from the by-year chart.",
                ["date"], lambda d: d["date"].isna()),
        RowRule("date_after_through", "Connected after the data-through date", ERROR,
                "The connection date is later than the date the list is said to cover, which cannot both be right.",
                ["date", "through"], lambda d: d["date"] > d["through"]),
        RowRule("bad_zip", "ZIP code is not five digits", WARNING,
                "The ZIP code is missing or malformed, so the project cannot be placed on the map.",
                ["zip"], lambda d: ~is_zip(d["zip"])),
        RowRule("zip_outside_ny", "ZIP code is outside New York", WARNING,
                "A valid ZIP code, but not one used in New York, so it is not placed on the map.",
                ["zip"], lambda d: is_zip(d["zip"]) & ~is_ny_zip(d["zip"])),
        RowRule("county_outside_ny", "County is not a New York county", WARNING,
                "The county named is not one of New York's 62 counties.",
                ["county"], lambda d: d["county"].notna() & ~d["county"].isin(NY_COUNTIES)),
        RowRule("no_circuit", "No circuit ID", INFO,
                "The project cannot be matched to a line. It still counts in the ZIP and state totals.",
                ["circuit"], lambda d: d["circuit"].isna()),
        RowRule("no_metering", "No metering method", INFO,
                "Whether the project is community solar or a home or business system is not stated.",
                ["metering"], lambda d: d["metering"].isna()),
        RowRule("duplicate_project_id", "Project ID used more than once", INFO,
                "The same project ID appears on more than one row. Both rows are counted, as published.",
                ["project_id"], lambda d: d["project_id"].notna() & d["project_id"].duplicated(keep=False)),
    ]
    if mapped:
        rules.append(RowRule(
            "zip_not_mapped", "No Census ZIP area for this ZIP code", INFO,
            "Often a ZIP code for post office boxes or one large building. Counted in the state totals, not drawn on the map.",
            ["zip"], lambda d: is_ny_zip(d["zip"]) & ~d["zip"].isin(mapped)))
    return rules


def run_checks(df: pd.DataFrame, mapped_zips: Iterable[str] | None = None) -> list[dict]:
    """Every check's result, plus the kW on the rows it flagged (how much of the total it touches)."""
    rules = {rule.rule_id: rule for rule in default_rules(mapped_zips)}
    results: list[RuleResult] = QualityChecker(list(rules.values()), record_id="project_id").run(df)
    out = []
    for r in results:
        item = {k: v for k, v in asdict(r).items() if k != "feeders"}  # rows here are projects, not lines
        item["kw"] = _kw(df.loc[rules[r.rule_id].check(df), "kw"].sum()) if r.status == "ran" and r.flagged else 0.0
        out.append(item)
    return out


# ---------- totals ----------
def _kw(value) -> float:
    return 0.0 if pd.isna(value) else round(float(value), 1)


def _month(value) -> str | None:
    return None if pd.isna(value) else pd.Timestamp(value).strftime("%Y-%m")


def place_name(value: str) -> str:
    """Some rows are in capitals ("NEW CITY"), most are not ("New City"): count them as one."""
    return value.title() if value.isupper() else value


def _most_common(values: pd.Series, tidy: Callable[[str], str] = place_name) -> str | None:
    """The value on the most rows; ties go to the first in alphabetical order, so runs agree."""
    names = values.dropna().map(tidy)
    if names.empty:
        return None
    counts = names.value_counts()
    return str(min(counts.index, key=lambda name: (-counts[name], name)))


def recent(df: pd.DataFrame, through: pd.Timestamp) -> pd.Series:
    """Connected in the 12 months up to the data-through date."""
    return df["date"].notna() & (df["date"] > through - pd.DateOffset(years=1)) & (df["date"] <= through)


def by_feeder(df: pd.DataFrame, sources: Iterable[Source] = SOURCES.values()) -> dict[str, dict[str, list]]:
    """Per source on our map and per circuit ID: [kW, systems, latest connection YYYY-MM]."""
    out: dict[str, dict[str, list]] = {}
    for source in sources:
        if not source.nyserda_utility:
            continue
        rows = df[(df["utility"] == source.nyserda_utility) & df["circuit"].notna()]
        grouped = rows.groupby("circuit").agg(kw=("kw", "sum"), systems=("systems", "sum"), last=("date", "max"))
        out[source.source_id] = {str(name): [_kw(g.kw), int(g.systems), _month(g.last)]
                                 for name, g in grouped.sort_index().iterrows()}
    return out


def feeder_match(df: pd.DataFrame, feeders: dict[str, dict[str, list]], our_feeders: dict[str, set[str]],
                 sources: Iterable[Source] = SOURCES.values()) -> dict[str, dict]:
    """How much of each utility's solar sits on our feeders that have a published capacity."""
    out = {}
    for source in sources:
        if not source.nyserda_utility or source.source_id not in feeders:
            continue
        ours = our_feeders.get(source.source_id, set())
        records = feeders[source.source_id]
        matched = [name for name in records if name in ours]
        utility_rows = df[df["utility"] == source.nyserda_utility]
        out[source.source_id] = {
            "nyserda_name": source.nyserda_utility,
            "feeders_with_capacity": len(ours),
            "feeders_with_solar": len(matched),
            "kw_matched": _kw(sum(records[n][0] for n in matched)),
            "kw_utility": _kw(utility_rows["kw"].sum()),
            "systems_utility": int(utility_rows["systems"].sum()),
        }
    return out


def by_zip(df: pd.DataFrame, points: pd.DataFrame, through: pd.Timestamp) -> tuple[dict, dict]:
    """One GeoJSON point per ZIP code with solar, and the totals that could not be placed."""
    located = df.assign(recent_kw=df["kw"].where(recent(df, through)),
                        community=df["systems"].where((df["metering"] == COMMUNITY_SOLAR).fillna(False), 0))
    located = located[is_ny_zip(located["zip"]) & located["zip"].isin(points.index)]
    features = []
    for zip_code, g in located.groupby("zip", sort=True):
        lon, lat = points.loc[zip_code, ["lon", "lat"]]
        props = {
            "zip": zip_code,
            "place": _most_common(g["city"]),
            "county": _most_common(g["county"]),
            "u": _most_common(g["utility"], str),  # the utility serving most of its projects, as NYSERDA names it
            "kw": _kw(g["kw"].sum()),
            "n": int(g["systems"].sum()),
            "cn": int(g["community"].sum()),
            "st": _kw(g["storage_kw"].sum()),
            "r12": _kw(g["recent_kw"].sum()),
            "last": _month(g["date"].max()),
        }
        features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon, 4), round(lat, 4)]},
                         "properties": {k: v for k, v in props.items() if v is not None}})
    placed = df.index.isin(located.index)
    unplaced = {"systems": int(df.loc[~placed, "systems"].sum()), "kw": _kw(df.loc[~placed, "kw"].sum())}
    return {"type": "FeatureCollection", "features": features}, unplaced


def summarize(df: pd.DataFrame, through: pd.Timestamp, zips: dict, unplaced: dict, checks: list[dict],
              match: dict[str, dict], generated: datetime | None = None) -> dict:
    community = (df["metering"] == COMMUNITY_SOLAR).fillna(False).astype(bool)
    last_year = recent(df, through)
    years = df[df["date"].notna()].groupby(df["date"].dt.year).agg(systems=("systems", "sum"), kw=("kw", "sum"))
    utilities = df.groupby(df["utility"].fillna("Not stated")).agg(systems=("systems", "sum"), kw=("kw", "sum"))
    utilities = utilities.sort_values("kw", ascending=False)
    return {
        "generated_utc": (generated or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "data_through": through.strftime("%Y-%m-%d"),
        "source": {"publisher": PUBLISHER, "name": DATASET_NAME, "url": DATASET_PAGE},
        "rows": len(df),
        "totals": {
            "systems": int(df["systems"].sum()),
            "kw": _kw(df["kw"].sum()),
            "storage_kw": _kw(df["storage_kw"].sum()),
            "community_systems": int(df.loc[community, "systems"].sum()),
            "community_kw": _kw(df.loc[community, "kw"].sum()),
            "zips": len(zips["features"]),
        },
        "last_12_months": {"systems": int(df.loc[last_year, "systems"].sum()), "kw": _kw(df.loc[last_year, "kw"].sum())},
        "by_year": [{"year": int(y), "systems": int(r.systems), "kw": _kw(r.kw)} for y, r in years.iterrows()],
        "by_utility": [{"name": str(n), "systems": int(r.systems), "kw": _kw(r.kw)} for n, r in utilities.iterrows()],
        "unplaced": unplaced,
        "feeders": match,
        "checks": checks,
    }


# ---------- outside data ----------
def fetch_rows(collector: SodaCollector | None = None) -> pd.DataFrame:
    collector = collector or SodaCollector(PORTAL, DATASET_ID)
    raw = collector.collect(COLUMNS)
    if raw.empty:
        raise InstalledSolarError("The dataset returned no rows")
    return raw


def fetch_zip_points(zip_codes: Iterable[str], collector: ArcGISRestCollector | None = None,
                     chunk: int = 400) -> pd.DataFrame:
    """Census internal point of each ZIP Code Tabulation Area, indexed by ZIP code."""
    collector = collector or ArcGISRestCollector(ZCTA_LAYER, batch_size=1000, pause_seconds=0.3)
    codes = sorted({z for z in zip_codes if isinstance(z, str) and len(z) == 5 and z.isdigit()})
    frames = []
    for start in range(0, len(codes), chunk):  # keeps each query's where clause a moderate size
        listed = ",".join(f"'{z}'" for z in codes[start:start + chunk])
        frames.append(collector.fetch_records(f"ZCTA5 IN ({listed})", ZCTA_FIELDS))
    return zip_points(pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=ZCTA_FIELDS))


def zip_points(records: pd.DataFrame) -> pd.DataFrame:
    """Clean lat, lon per ZIP code from Census records (their coordinates are text like "+42.1")."""
    points = pd.DataFrame({
        "zip": records["ZCTA5"].astype("string").str.strip(),
        "lat": pd.to_numeric(records["INTPTLAT"], errors="coerce"),
        "lon": pd.to_numeric(records["INTPTLON"], errors="coerce"),
    }).dropna()
    points = points[points["lat"].between(40, 46) & points["lon"].between(-80.5, -71)]  # New York and a margin
    return points.drop_duplicates("zip").set_index("zip")


def our_feeders(history_path: Path | None) -> dict[str, set[str]]:
    """Feeders with a published value on the latest date of the capacity history."""
    if history_path is None:
        return {}
    history = FeederHistory.load(history_path)
    return {source_id: {name for name, values in entry["feeders"].items() if values and values[-1] is not None}
            for source_id, entry in history.sources.items()}


# ---------- writing ----------
def _write_json(path: Path, payload, compact: bool = True) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, separators=(",", ":")) if compact else json.dumps(payload, indent=2)
    replace_atomically(path, lambda tmp: tmp.write_text(text + "\n", encoding="utf-8"))
    return path


def quality_report(summary: dict) -> str:
    """Markdown for people. No run time in it, so it only changes when NYSERDA's data does."""
    t = summary["totals"]
    lines = [
        "# Data quality report: solar already built (NYSERDA)", "",
        f"Source: [{summary['source']['name']}]({summary['source']['url']})  ",
        f"Data through: {summary['data_through']}  ",
        f"Rows checked: {summary['rows']:,} ({t['systems']:,} systems, {t['kw'] / 1000:,.1f} MW)", "",
        "| Severity | Check | Flagged rows | % of rows | kW on flagged rows | Example project IDs |",
        "|---|---|---:|---:|---:|---|",
    ]
    for c in summary["checks"]:
        if c["status"] != "ran":
            lines.append(f"| {c['severity'].upper()} | {c['title']} | could not run | | | |")
            continue
        ids = ", ".join(str(x) for x in c["example_ids"]) or "none"
        lines.append(f"| {c['severity'].upper()} | {c['title']} | {c['flagged']:,} | {c['percent']} | "
                     f"{c.get('kw', 0):,} | {ids} |")
    lines += ["", "## Matching to feeders on the capacity map", "",
              "| Utility | Feeders with a published capacity | With solar on record | Solar on those feeders | All of the utility's solar |",
              "|---|---:|---:|---:|---:|"]
    for m in summary["feeders"].values():
        lines.append(f"| {m['nyserda_name']} | {m['feeders_with_capacity']:,} | {m['feeders_with_solar']:,} | "
                     f"{m['kw_matched'] / 1000:,.1f} MW | {m['kw_utility'] / 1000:,.1f} MW |")
    lines += ["", f"Not placed on the map (no usable ZIP code): {summary['unplaced']['systems']:,} systems, "
              f"{summary['unplaced']['kw'] / 1000:,.1f} MW. They are still in the state totals.", "",
              "Flags mean 'worth checking', not proof of an error. Rows are counted as published."]
    return "\n".join(lines) + "\n"


@dataclass
class Built:
    summary: dict
    zips: dict
    feeders: dict

    def write(self, out_dir: Path, report_dir: Path | None = None) -> list[Path]:
        through = self.summary["data_through"]
        paths = [
            _write_json(out_dir / "solar_summary.json", self.summary, compact=False),
            _write_json(out_dir / "solar_zips.geojson", self.zips),
            _write_json(out_dir / "solar_feeders.json", {"generated_utc": self.summary["generated_utc"],
                                                         "data_through": through, "sources": self.feeders}),
        ]
        if report_dir is not None:
            report_dir.mkdir(parents=True, exist_ok=True)
            report = report_dir / "quality.md"
            replace_atomically(report, lambda tmp: tmp.write_text(quality_report(self.summary), encoding="utf-8"))
            paths.append(report)
        return paths


def build(raw: pd.DataFrame, points: pd.DataFrame, history: dict[str, set[str]] | None = None,
          generated: datetime | None = None) -> Built:
    """Everything the site needs, from the portal's rows and the Census ZIP points."""
    df = prepare(raw)
    through = data_through(df)
    checks = run_checks(df, points.index)
    zips, unplaced = by_zip(df, points, through)
    feeders = by_feeder(df)
    match = feeder_match(df, feeders, history or {})
    summary = summarize(df, through, zips, unplaced, checks, match, generated)
    return Built(summary, zips, feeders)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the 'solar already built' files for the website.")
    parser.add_argument("--out", default="data/tiles", type=Path, help="Folder for the website's files")
    parser.add_argument("--history", default="reports/history/feeder_capacity.json", type=Path,
                        help="Capacity history, used to count which of our feeders have solar on record")
    parser.add_argument("--report", default="reports/installed_solar", type=Path,
                        help="Folder for the committed quality report")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    raw = fetch_rows()
    points = fetch_zip_points(raw["zip"].dropna().str.strip())
    built = build(raw, points, our_feeders(args.history))
    paths = built.write(args.out, args.report)
    t = built.summary["totals"]
    print(f"\nSolar already built, data through {built.summary['data_through']}: "
          f"{t['systems']:,} systems, {t['kw'] / 1000:,.1f} MW in {t['zips']:,} ZIP codes")
    for path in paths:
        print(f"  {path}")


if __name__ == "__main__":
    main()
