"""Run the quality checker on a saved snapshot.

Usage:
    python -m capacity_atlas.quality --source central_hudson_ny_pv --snapshot data/snapshots/central_hudson_ny_pv/2026-09-30.parquet
"""

from __future__ import annotations

import argparse
from pathlib import Path

from capacity_atlas.quality.checker import SEVERITY_ICON
from capacity_atlas.quality.runner import check_snapshot
from capacity_atlas.sources import SOURCES, get_source


def main() -> None:
    parser = argparse.ArgumentParser(description="Check a snapshot for data quality problems.")
    parser.add_argument("--source", required=True, choices=sorted(SOURCES))
    parser.add_argument("--snapshot", required=True, type=Path)
    args = parser.parse_args()

    run = check_snapshot(get_source(args.source), args.snapshot)

    print(f"Checked {run.rows:,} rows (reference date {run.reference.date()})\n")
    for r in run.results:
        count = "skipped" if r.status == "skipped" else f"{r.flagged:>8,}  ({r.percent}%)"
        print(f"  [{SEVERITY_ICON[r.severity]:<7}] {r.title:<62} {count}")
    print(f"\nReports saved:\n  {run.json_path}\n  {run.md_path}")


if __name__ == "__main__":
    main()
