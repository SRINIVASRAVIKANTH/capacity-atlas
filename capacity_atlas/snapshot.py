"""Dated snapshots of each source: saving them safely and finding them again.

Two places hold snapshots:
  data/snapshots/<source_id>/<YYYY-MM-DD>.parquet   written by this run
  data/previous/<source_id>_<YYYY-MM-DD>.parquet    downloaded from earlier GitHub Releases
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime
from pathlib import Path

import geopandas as gpd

from capacity_atlas.sources import Source

DATE_IN_NAME = re.compile(r"(\d{4}-\d{2}-\d{2})$")


def _replace_atomically(target: Path, write) -> None:
    """Write to a temporary file next to the target, then rename it over the target.

    A run that is stopped halfway (time limit, crash, full disk) leaves the old file in place
    instead of a half-written one that would break next week's comparison.
    """
    tmp = target.with_name(f".{target.name}.tmp")
    try:
        write(tmp)
        os.replace(tmp, target)
    finally:
        tmp.unlink(missing_ok=True)


def save_snapshot(
    gdf: gpd.GeoDataFrame,
    source: Source,
    root: Path,
    fetched_at: datetime,
) -> Path:
    """Write data/snapshots/<source_id>/<YYYY-MM-DD>.parquet plus a metadata file."""
    folder = root / source.source_id
    folder.mkdir(parents=True, exist_ok=True)

    stem = fetched_at.strftime("%Y-%m-%d")
    data_path = folder / f"{stem}.parquet"
    meta_path = folder / f"{stem}.meta.json"

    _replace_atomically(data_path, lambda tmp: gdf.to_parquet(tmp, index=False))
    meta = {
        "source_id": source.source_id,
        "utility": source.utility,
        "state": source.state,
        "capacity_type": source.capacity_type,
        "layer_url": source.layer_url,
        "fetched_at_utc": fetched_at.isoformat(),
        "feature_count": int(len(gdf)),
        "columns": [c for c in gdf.columns if c != "geometry"],
    }
    _replace_atomically(meta_path, lambda tmp: tmp.write_text(json.dumps(meta, indent=2), encoding="utf-8"))
    return data_path


def snapshot_day(path: Path) -> str:
    """The YYYY-MM-DD date in a snapshot's file name (2026-10-08.parquet or src_2026-10-08.parquet)."""
    match = DATE_IN_NAME.search(path.stem)
    if not match:
        raise ValueError(f"Cannot read a date from the snapshot name '{path.name}'.")
    return match.group(1)


class SnapshotStore:
    """Finds the snapshots of a source across this run's folder and earlier release downloads."""

    def __init__(self, data_root: Path, previous_dir: Path | None = None) -> None:
        self.data_root = data_root
        self.previous_dir = previous_dir

    def by_date(self, source_id: str) -> dict[str, Path]:
        """Every snapshot of one source, keyed by date. This run's file wins over a release copy."""
        found: dict[str, Path] = {}
        if self.previous_dir and self.previous_dir.exists():
            prefix = f"{source_id}_"
            for path in self.previous_dir.glob(f"{prefix}*.parquet"):
                if DATE_IN_NAME.search(path.stem):
                    found[snapshot_day(path)] = path
        for path in (self.data_root / source_id).glob("*.parquet"):
            if DATE_IN_NAME.search(path.stem):
                found[snapshot_day(path)] = path
        return found

    def latest(self, source_id: str) -> Path | None:
        found = self.by_date(source_id)
        return found[max(found)] if found else None

    def before(self, source_id: str, day: str) -> Path | None:
        """Newest snapshot dated strictly before `day` (YYYY-MM-DD)."""
        found = self.by_date(source_id)
        earlier = [d for d in found if d < day]
        return found[max(earlier)] if earlier else None
