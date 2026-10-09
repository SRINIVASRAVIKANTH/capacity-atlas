"""Build the web map's data: one vector tile file (PMTiles) plus a small summary.json.

The tile file has two layers:

    lines     every line section, shown when zoomed in (zoom 11 and closer)
    overview  the same network for zoomed-out views (zoom 5 to 10): neighboring sections
              of one feeder that share a capacity band are merged into continuous lines,
              so the state-wide map shows whole circuits instead of broken fragments

Each utility publishes different column names. Using each source's ColumnMap, every
line section is reduced to the same small set of fields, so the map can style all
utilities with one rule. The lines layer carries:

    src     source id (for example "national_grid_ny_pv")
    feeder  feeder / circuit name
    hc      published hosting capacity in MW, rounded to 2 decimals (missing = not analyzed)
    q       data quality flags for this line section, one bit per check (see FLAG_IDS)
    qs      worst flag level on this line: 0 none or info only, 1 warning, 2 error
    sub     substation name          (only if the utility publishes it)
    kv      line voltage in kV       (only if the utility publishes it)
    ph      phases, for example ABC  (only if the utility publishes it)
    ad      analysis date YYYY-MM-DD (only if the utility publishes it)
    m       section length in meters
    (id)    the tile feature id is a section number, unique within one weekly build, so
            the map can highlight a whole section even when it crosses tile edges

The overview layer carries src, feeder, qs, and hc set to the LOWER EDGE of the capacity
band (so the same colors and minimum-capacity filter work on both layers), plus per-feeder
facts for the zoomed-out detail card: fn (sections), fkm (length in km), fmin and fmax
(capacity range in MW), and fx0, fy0, fx1, fy1 (the feeder's bounding box).

summary.json carries what the side panel shows: per-utility totals, check results,
and the meaning of every flag bit.

The tiles themselves are cut by tippecanoe, the standard open-source tiler.

Usage:
    python -m capacity_atlas.tiles --out data/tiles/atlas.pmtiles
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

from capacity_atlas.quality.rules import ERROR, WARNING, QualityRule, default_rules, to_utc_datetime
from capacity_atlas.sources import SOURCES, Source

logger = logging.getLogger(__name__)

LAYER = "lines"
OVERVIEW_LAYER = "overview"
DETAIL_MIN_ZOOM = 11  # sections appear from this zoom; the overview is used below it
MIN_ZOOM = 5    # whole state
MAX_ZOOM = 15   # street level
LENGTH_CRS = 5070  # NAD83 / Conus Albers, used only to measure section lengths

# Capacity bands, matching the map legend. The overview stores each band's lower edge as hc.
BAND_EDGES = (0.0, 0.0001, 0.5, 1.0, 2.0, 5.0)  # zero, under 0.5, 0.5-1, 1-2, 2-5, 5+
BAND_FLOOR = (0.0, 0.01, 0.5, 1.0, 2.0, 5.0)

TIPPECANOE_ARGS = [
    "--minimum-zoom", str(MIN_ZOOM),
    "--maximum-zoom", str(MAX_ZOOM),
    "--drop-densest-as-needed",          # thin out lines only where a tile is overloaded
    "--extend-zooms-if-still-dropping",  # keep full detail at street level
    "--use-attribute-for-id=sid",        # section number becomes the feature id
    # Each layer only at its own zooms: overview when zoomed out, sections when zoomed in.
    "--feature-filter", json.dumps({
        OVERVIEW_LAYER: ["<", "$zoom", DETAIL_MIN_ZOOM],
        LAYER: [">=", "$zoom", DETAIL_MIN_ZOOM],
    }),
    "--force",
    "--quiet",
]

# One bit per quality check, in a fixed order the web map relies on.
# Only ever ADD new ids at the end; reordering would change the meaning of old tiles.
FLAG_IDS: tuple[str, ...] = (
    "duplicate_shape_conflicting_capacity",
    "capacity_negative",
    "capacity_min_above_max",
    "capacity_above_limit",
    "map_color_mismatch",
    "feeder_without_substation",
    "substation_without_feeder",
    "feeder_without_phase",
    "feeder_without_capacity",
    "duplicate_shape",
    "stale_analysis_with_new_der",
    "capacity_below_all_limits",
)
FLAG_BIT = {rule_id: 1 << i for i, rule_id in enumerate(FLAG_IDS)}

DATE_IN_NAME = re.compile(r"(\d{4}-\d{2}-\d{2})$")


class TileBuildError(RuntimeError):
    """Raised when the map data cannot be built."""


@dataclass
class SourceSummary:
    source_id: str
    utility: str
    state: str
    snapshot_date: str
    sections: int
    analyzed: int
    zero_mw: int
    median_mw: float | None
    max_mw: float | None
    checks: list[dict] = field(default_factory=list)


def latest_snapshot(source_id: str, data_root: Path, previous_dir: Path | None = None) -> Path | None:
    """Newest snapshot of a source: this run's folder first, then last week's release files."""
    candidates: dict[str, Path] = {}
    if previous_dir and previous_dir.exists():
        prefix = f"{source_id}_"
        for path in previous_dir.glob(f"{prefix}*.parquet"):
            candidates[path.stem[len(prefix):]] = path
    for path in (data_root / source_id).glob("*.parquet"):
        candidates[path.stem] = path  # this run's file wins over a release copy of the same date
    if not candidates:
        return None
    return candidates[max(candidates)]


def snapshot_date(path: Path) -> datetime:
    """Snapshot files are named by download date (2026-10-08.parquet or source_2026-10-08.parquet)."""
    match = DATE_IN_NAME.search(path.stem)
    if not match:
        raise TileBuildError(f"Cannot read a date from the snapshot name '{path.name}'.")
    return datetime.strptime(match.group(1), "%Y-%m-%d").replace(tzinfo=timezone.utc)


def _optional(gdf: gpd.GeoDataFrame, column: str | None) -> pd.Series | None:
    return gdf[column] if column and column in gdf.columns else None


def _ready(rule: QualityRule, gdf: gpd.GeoDataFrame) -> bool:
    return all(c in gdf.columns for c in rule.required_columns())


def map_features(
    source: Source, gdf: gpd.GeoDataFrame, reference: datetime
) -> tuple[gpd.GeoDataFrame, SourceSummary]:
    """Reduce one source's snapshot to the shared map fields and summarize it."""
    if source.columns is None:
        raise TileBuildError(f"Source '{source.source_id}' has no column map.")
    c = source.columns
    gdf = gdf.reset_index(drop=True)

    capacity = _optional(gdf, c.capacity_mw)
    hc = capacity.round(2) if capacity is not None else pd.Series(np.nan, index=gdf.index)
    feeder = _optional(gdf, c.feeder)

    # Run every quality check once: it gives both the per-line flag bits and the panel totals.
    flags = np.zeros(len(gdf), dtype=np.int64)
    level = np.zeros(len(gdf), dtype=np.int8)
    checks = []
    for rule in default_rules(c, reference):
        if not _ready(rule, gdf):
            continue
        hit = rule.check(gdf).to_numpy(dtype=bool)
        if rule.rule_id in FLAG_BIT:
            flags[hit] |= FLAG_BIT[rule.rule_id]
            severity = {ERROR: 2, WARNING: 1}.get(rule.severity, 0)
            level[hit] = np.maximum(level[hit], severity)
        checks.append({
            "id": rule.rule_id,
            "title": rule.title,
            "severity": rule.severity,
            "flagged": int(hit.sum()),
            "feeders": int(feeder[hit].nunique()) if feeder is not None else None,
        })

    columns = {
        "src": source.source_id,
        "feeder": feeder.astype("string") if feeder is not None else pd.NA,
        "hc": hc,
        "q": flags,
        "qs": level,
    }
    for key, series in (("sub", _optional(gdf, c.substation)), ("ph", _optional(gdf, c.phases))):
        if series is not None:
            columns[key] = series.astype("string")
    voltage = _optional(gdf, "Voltage_kV") if "Voltage_kV" in gdf.columns else _optional(gdf, "primary_voltage")
    if voltage is not None:
        columns["kv"] = pd.to_numeric(voltage, errors="coerce").round(1)
    analysis = _optional(gdf, c.analysis_date)
    if analysis is not None:
        columns["ad"] = to_utc_datetime(analysis).dt.strftime("%Y-%m-%d")

    out = gpd.GeoDataFrame(columns, geometry=gdf.geometry, crs=gdf.crs)
    shapes = np.asarray(out.geometry.values, dtype=object)
    out = out[~(shapely.is_missing(shapes) | shapely.is_empty(shapes))]
    # Length in an equal-area projection for the contiguous US (meters, error well under 1%).
    out["m"] = out.geometry.to_crs(LENGTH_CRS).length.round().astype("int64")
    out = out.to_crs(4326)

    analyzed = hc.dropna()
    summary = SourceSummary(
        source_id=source.source_id,
        utility=source.utility,
        state=source.state,
        snapshot_date=reference.strftime("%Y-%m-%d"),
        sections=int(len(gdf)),
        analyzed=int(len(analyzed)),
        zero_mw=int((analyzed == 0).sum()),
        median_mw=float(analyzed.median()) if len(analyzed) else None,
        max_mw=float(analyzed.max()) if len(analyzed) else None,
        checks=checks,
    )
    return out, summary


def combine(snapshots: dict[str, Path]) -> tuple[gpd.GeoDataFrame, list[SourceSummary]]:
    frames, summaries = [], []
    for source_id, path in snapshots.items():
        frame, summary = map_features(SOURCES[source_id], gpd.read_parquet(path), snapshot_date(path))
        logger.info("%s: %d line sections from %s", source_id, len(frame), path)
        frames.append(frame)
        summaries.append(summary)
    if not frames:
        raise TileBuildError("No snapshots found for any source; nothing to draw.")
    features = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), geometry="geometry", crs=4326)
    features["sid"] = np.arange(1, len(features) + 1, dtype=np.int64)
    return features, summaries


def capacity_band(hc: pd.Series) -> pd.Series:
    """Band index per line: -1 not analyzed, 0 zero, then one band per legend step."""
    band = pd.Series(-1, index=hc.index, dtype="int64")
    for i, edge in enumerate(BAND_EDGES):
        band[hc >= edge] = i
    return band


def build_overview(features: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Merge touching sections of one feeder that share a capacity band and issue level."""
    f = features[["src", "feeder", "hc", "qs", "m", "geometry"]].copy()
    f["feeder"] = f["feeder"].astype("string").fillna("")
    f["band"] = capacity_band(f["hc"])

    # Facts about each whole feeder, shown when someone clicks it while zoomed out.
    bounds = f.geometry.bounds
    f = f.join(bounds)
    per_feeder = f.groupby(["src", "feeder"]).agg(
        fn=("m", "size"), fkm=("m", "sum"), fmin=("hc", "min"), fmax=("hc", "max"),
        fx0=("minx", "min"), fy0=("miny", "min"), fx1=("maxx", "max"), fy1=("maxy", "max"),
    )
    per_feeder["fkm"] = (per_feeder["fkm"] / 1000).round(1)
    per_feeder[["fx0", "fy0", "fx1", "fy1"]] = per_feeder[["fx0", "fy0", "fx1", "fy1"]].round(4)

    # Flatten to single lines, then merge each group's lines where their ends touch.
    keys = ["src", "feeder", "band", "qs"]
    group = f.groupby(keys, sort=False).ngroup().to_numpy()
    parts, owner = shapely.get_parts(f.geometry.to_numpy(), return_index=True)
    order = np.argsort(group[owner], kind="stable")  # shapely needs the parts sorted by group
    merged = shapely.line_merge(shapely.multilinestrings(parts[order], indices=group[owner][order]))

    groups = f.groupby(keys, sort=False).size().reset_index()[keys]
    groups = groups.join(per_feeder, on=["src", "feeder"])
    groups["hc"] = [BAND_FLOOR[b] if b >= 0 else np.nan for b in groups["band"]]
    groups["feeder"] = groups["feeder"].replace("", pd.NA)
    out = gpd.GeoDataFrame(groups.drop(columns="band"), geometry=merged, crs=features.crs)
    return out[~shapely.is_empty(out.geometry.to_numpy())]


def flag_legend() -> list[dict]:
    """What each flag bit means, taken from the rules themselves so the text never drifts."""
    meaning = {}
    for source in SOURCES.values():
        if source.columns is None:
            continue
        for rule in default_rules(source.columns, datetime.now(timezone.utc)):
            meaning.setdefault(rule.rule_id, rule)
    legend = []
    for rule_id in FLAG_IDS:
        rule = meaning.get(rule_id)
        if rule is not None:
            legend.append({"bit": FLAG_BIT[rule_id], "id": rule_id, "title": rule.title,
                           "severity": rule.severity, "explanation": rule.explanation})
    return legend


def write_summary(summaries: list[SourceSummary], out: Path, generated: datetime | None = None) -> Path:
    payload = {
        "generated_utc": (generated or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "flags": flag_legend(),
        "sources": [s.__dict__ for s in summaries],
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return out


def find_tippecanoe(explicit: str | None = None) -> str:
    path = explicit or shutil.which("tippecanoe")
    if not path or not Path(path).exists():
        raise TileBuildError(
            "tippecanoe was not found. It runs on Linux and macOS (the weekly GitHub run "
            "installs it automatically). See https://github.com/felt/tippecanoe"
        )
    return path


def build_tiles(features: gpd.GeoDataFrame, out: Path, tippecanoe: str) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    overview = build_overview(features)
    logger.info("Overview: %d merged lines from %d sections", len(overview), len(features))
    with tempfile.TemporaryDirectory() as tmp:
        lines = Path(tmp) / "lines.geojsonl"
        merged = Path(tmp) / "overview.geojsonl"
        features.to_file(lines, driver="GeoJSONSeq")
        overview.to_file(merged, driver="GeoJSONSeq")
        result = subprocess.run(
            [tippecanoe, "--output", str(out), *TIPPECANOE_ARGS,
             "--named-layer", f"{LAYER}:{lines}", "--named-layer", f"{OVERVIEW_LAYER}:{merged}"],
            capture_output=True, text=True,
        )
    if result.returncode != 0 or not out.exists():
        raise TileBuildError(f"tippecanoe failed ({result.returncode}): {result.stderr[-2000:]}")
    logger.info("Built %s (%.1f MB)", out, out.stat().st_size / 1e6)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the web map's tile file and summary.")
    parser.add_argument("--data", default="data/snapshots", type=Path)
    parser.add_argument("--previous", default=None, type=Path,
                        help="Folder of last week's release snapshots, used if a source failed this week")
    parser.add_argument("--out", default="data/tiles/atlas.pmtiles", type=Path)
    parser.add_argument("--tippecanoe", default=None, help="Path to the tippecanoe binary")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    tippecanoe = find_tippecanoe(args.tippecanoe)
    snapshots = {}
    for source_id in SOURCES:
        path = latest_snapshot(source_id, args.data, args.previous)
        if path is None:
            logger.warning("No snapshot for %s; it will be missing from the map.", source_id)
        else:
            snapshots[source_id] = path

    features, summaries = combine(snapshots)
    out = build_tiles(features, args.out, tippecanoe)
    summary = write_summary(summaries, args.out.with_name("summary.json"))
    print(f"\nMap tiles: {out} ({out.stat().st_size / 1e6:.1f} MB, {len(features):,} line sections)")
    print(f"Summary:   {summary}")


if __name__ == "__main__":
    main()
