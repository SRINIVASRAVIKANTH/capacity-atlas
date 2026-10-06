"""Run the quality checker on one saved snapshot. Used by the command line and the pipeline."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd

from capacity_atlas.quality.checker import QualityChecker, RuleResult, write_reports
from capacity_atlas.quality.rules import default_rules
from capacity_atlas.sources import Source


@dataclass
class QualityRun:
    rows: int
    reference: datetime
    results: list[RuleResult]
    json_path: Path
    md_path: Path


def snapshot_time(snapshot: Path) -> datetime:
    """Use the download time from the snapshot's metadata, so results are reproducible."""
    meta = Path(f"{snapshot.with_suffix('')}.meta.json")
    if meta.exists():
        return datetime.fromisoformat(json.loads(meta.read_text(encoding="utf-8"))["fetched_at_utc"])
    return datetime.now(timezone.utc)


def check_snapshot(source: Source, snapshot: Path) -> QualityRun:
    if source.columns is None:
        raise ValueError(f"Source '{source.source_id}' has no column map; cannot run checks.")
    gdf = gpd.read_parquet(snapshot)
    reference = snapshot_time(snapshot)
    checker = QualityChecker(
        default_rules(source.columns, reference),
        source.columns.record_id,
        feeder_column=source.columns.feeder,
    )
    results = checker.run(gdf)
    json_path, md_path = write_reports(results, snapshot, source.source_id)
    return QualityRun(len(gdf), reference, results, json_path, md_path)
