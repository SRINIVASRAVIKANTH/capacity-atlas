"""Command line entry point.

Usage:
    python -m capacity_atlas.cli --source central_hudson_ny_pv
"""

from __future__ import annotations

import argparse
import logging
from datetime import datetime, timezone
from pathlib import Path

from capacity_atlas.collectors import ArcGISRestCollector
from capacity_atlas.snapshot import save_snapshot
from capacity_atlas.sources import SOURCES, get_source


def main() -> None:
    parser = argparse.ArgumentParser(description="Download a hosting capacity snapshot.")
    parser.add_argument("--source", required=True, choices=sorted(SOURCES))
    parser.add_argument("--out", default="data/snapshots", help="Snapshot folder")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    source = get_source(args.source)
    collector = ArcGISRestCollector(
        source.layer_url,
        batch_size=source.batch_size,
        pause_seconds=source.pause_seconds,
    )
    gdf = collector.collect()
    path = save_snapshot(gdf, source, Path(args.out), datetime.now(timezone.utc))

    print(f"\nSaved {len(gdf)} features to {path}")
    print("Columns:", ", ".join(c for c in gdf.columns if c != "geometry"))


if __name__ == "__main__":
    main()
