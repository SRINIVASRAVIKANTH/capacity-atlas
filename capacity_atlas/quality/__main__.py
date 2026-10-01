"""Run the quality checker on a saved snapshot.

Usage:
    python -m capacity_atlas.quality --source central_hudson_ny_pv --snapshot data/snapshots/central_hudson_ny_pv/2026-09-30.parquet
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd

from capacity_atlas.quality.checker import SEVERITY_ICON, QualityChecker, write_reports
from capacity_atlas.quality.rules import default_rules
from capacity_atlas.sources import SOURCES, get_source


def snapshot_time(snapshot: Path) -> datetime:
    """Use the download time from the snapshot's metadata, so results are reproducible."""
    meta = Path(f"{snapshot.with_suffix('')}.meta.json")
    if meta.exists():
        return datetime.fromisoformat(json.loads(meta.read_text(encoding="utf-8"))["fetched_at_utc"])
    return datetime.now(timezone.utc)


def main() -> None:
    parser = argparse.ArgumentParser(description="Check a snapshot for data quality problems.")
    parser.add_argument("--source", required=True, choices=sorted(SOURCES))
    parser.add_argument("--snapshot", required=True, type=Path)
    args = parser.parse_args()

    source = get_source(args.source)
    if source.columns is None:
        raise SystemExit(f"Source '{source.source_id}' has no column map; cannot run checks.")

    gdf = gpd.read_parquet(args.snapshot)
    reference = snapshot_time(args.snapshot)
    checker = QualityChecker(default_rules(source.columns, reference), source.columns.record_id)
    results = checker.run(gdf)
    json_path, md_path = write_reports(results, args.snapshot, source.source_id)

    print(f"Checked {len(gdf):,} rows (reference date {reference.date()})\n")
    for r in results:
        count = "skipped" if r.status == "skipped" else f"{r.flagged:>8,}  ({r.percent}%)"
        print(f"  [{SEVERITY_ICON[r.severity]:<7}] {r.title:<62} {count}")
    print(f"\nReports saved:\n  {json_path}\n  {md_path}")


if __name__ == "__main__":
    main()
