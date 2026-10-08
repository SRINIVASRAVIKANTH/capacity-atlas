"""Build one vector tile file (PMTiles) covering every source, for the web map.

Each utility publishes different column names. Using each source's ColumnMap, every
line section is reduced to the same small set of fields, so the map can style all
utilities with one rule:

    src     source id (for example "national_grid_ny_pv")
    feeder  feeder / circuit name
    hc      published hosting capacity in MW, rounded to 2 decimals (missing = not analyzed)

The tiles themselves are cut by tippecanoe, the standard open-source tiler.

Usage:
    python -m capacity_atlas.tiles --out data/tiles/atlas.pmtiles
"""

from __future__ import annotations

import argparse
import logging
import shutil
import subprocess
import tempfile
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

from capacity_atlas.sources import SOURCES, Source

logger = logging.getLogger(__name__)

LAYER = "lines"
MIN_ZOOM = 5    # whole state
MAX_ZOOM = 15   # street level

TIPPECANOE_ARGS = [
    "--layer", LAYER,
    "--minimum-zoom", str(MIN_ZOOM),
    "--maximum-zoom", str(MAX_ZOOM),
    "--drop-densest-as-needed",          # thin out lines only where a tile is overloaded
    "--extend-zooms-if-still-dropping",  # keep full detail at street level
    "--force",
    "--quiet",
]


class TileBuildError(RuntimeError):
    """Raised when the tile file cannot be built."""


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


def map_features(source: Source, gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Reduce one source's snapshot to the shared map fields."""
    if source.columns is None:
        raise ValueError(f"Source '{source.source_id}' has no column map.")
    c = source.columns
    out = gpd.GeoDataFrame(
        {
            "src": source.source_id,
            "feeder": gdf[c.feeder].astype("string") if c.feeder in gdf.columns else pd.NA,
            "hc": gdf[c.capacity_mw].round(2) if c.capacity_mw and c.capacity_mw in gdf.columns
            else float("nan"),
        },
        geometry=gdf.geometry,
        crs=gdf.crs,
    )
    shapes = np.asarray(out.geometry.values, dtype=object)
    out = out[~(shapely.is_missing(shapes) | shapely.is_empty(shapes))]
    return out.to_crs(4326)


def combine(snapshots: dict[str, Path]) -> gpd.GeoDataFrame:
    frames = []
    for source_id, path in snapshots.items():
        frame = map_features(SOURCES[source_id], gpd.read_parquet(path))
        logger.info("%s: %d line sections from %s", source_id, len(frame), path)
        frames.append(frame)
    if not frames:
        raise TileBuildError("No snapshots found for any source; nothing to draw.")
    return gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), geometry="geometry", crs=4326)


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
    with tempfile.TemporaryDirectory() as tmp:
        lines = Path(tmp) / "lines.geojsonl"
        features.to_file(lines, driver="GeoJSONSeq")
        result = subprocess.run(
            [tippecanoe, "--output", str(out), *TIPPECANOE_ARGS, str(lines)],
            capture_output=True, text=True,
        )
    if result.returncode != 0 or not out.exists():
        raise TileBuildError(f"tippecanoe failed ({result.returncode}): {result.stderr[-2000:]}")
    logger.info("Built %s (%.1f MB)", out, out.stat().st_size / 1e6)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the map tile file for every source.")
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

    features = combine(snapshots)
    out = build_tiles(features, args.out, tippecanoe)
    print(f"\nMap tiles: {out} ({out.stat().st_size / 1e6:.1f} MB, {len(features):,} line sections)")


if __name__ == "__main__":
    main()
