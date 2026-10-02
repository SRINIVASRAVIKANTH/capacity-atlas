"""The full weekly run: download, save, check, and publish reports for every source.

Usage:
    python -m capacity_atlas.pipeline --all
    python -m capacity_atlas.pipeline --source central_hudson_ny_pv

One failing utility never stops the others. The command exits with code 1 at the
end if any source failed, so automation can report the failure.
"""

from __future__ import annotations

import argparse
import logging
import shutil
import sys
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from capacity_atlas.collectors import ArcGISRestCollector
from capacity_atlas.quality.rules import ERROR, INFO, WARNING
from capacity_atlas.quality.runner import check_snapshot
from capacity_atlas.snapshot import save_snapshot
from capacity_atlas.sources import SOURCES, Source, get_source

logger = logging.getLogger(__name__)

CollectorFactory = Callable[[Source], object]


def default_collector(source: Source) -> ArcGISRestCollector:
    return ArcGISRestCollector(
        source.layer_url, batch_size=source.batch_size, pause_seconds=source.pause_seconds
    )


@dataclass
class SourceRun:
    source_id: str
    utility: str
    ok: bool
    rows: int = 0
    snapshot: Path | None = None
    errors: int = 0
    warnings: int = 0
    info: int = 0
    message: str = ""


def run_source(
    source: Source,
    data_root: Path,
    reports_root: Path,
    fetched_at: datetime,
    make_collector: CollectorFactory = default_collector,
) -> SourceRun:
    try:
        gdf = make_collector(source).collect()
        snapshot = save_snapshot(gdf, source, data_root, fetched_at)
        quality = check_snapshot(source, snapshot)

        # Small files go into the repository so the history is visible on GitHub.
        target = reports_root / source.source_id
        target.mkdir(parents=True, exist_ok=True)
        meta = Path(f"{snapshot.with_suffix('')}.meta.json")
        for path in (meta, quality.json_path, quality.md_path):
            shutil.copy2(path, target / path.name)

        counts = {ERROR: 0, WARNING: 0, INFO: 0}
        for r in quality.results:
            if r.status == "ran" and r.flagged:
                counts[r.severity] += 1
        return SourceRun(source.source_id, source.utility, True, quality.rows, snapshot,
                         counts[ERROR], counts[WARNING], counts[INFO], "ok")
    except Exception as exc:  # one utility failing must not stop the others
        logger.exception("Source %s failed", source.source_id)
        return SourceRun(source.source_id, source.utility, False, message=f"{type(exc).__name__}: {exc}")


def write_summary(runs: list[SourceRun], reports_root: Path, fetched_at: datetime) -> Path:
    """reports/LATEST.md: one table showing the state of every source after this run."""
    lines = [
        "# Latest run",
        "",
        f"Run time (UTC): {fetched_at.strftime('%Y-%m-%d %H:%M')}",
        "",
        "| Source | Utility | Status | Rows | Rules with errors | Rules with warnings | Rules with info |",
        "|---|---|---|---:|---:|---:|---:|",
    ]
    for r in runs:
        status = "OK" if r.ok else f"FAILED: {r.message[:120]}"
        lines.append(f"| `{r.source_id}` | {r.utility} | {status} | {r.rows:,} | "
                     f"{r.errors} | {r.warnings} | {r.info} |")
    lines += ["", "Full reports for each source are in its folder in this directory."]
    reports_root.mkdir(parents=True, exist_ok=True)
    path = reports_root / "LATEST.md"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def run_all(
    sources: list[Source],
    data_root: Path,
    reports_root: Path,
    fetched_at: datetime | None = None,
    make_collector: CollectorFactory = default_collector,
) -> list[SourceRun]:
    fetched_at = fetched_at or datetime.now(timezone.utc)
    runs = [run_source(s, data_root, reports_root, fetched_at, make_collector) for s in sources]
    write_summary(runs, reports_root, fetched_at)
    return runs


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the full pipeline.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--all", action="store_true", help="Run every source")
    group.add_argument("--source", choices=sorted(SOURCES))
    parser.add_argument("--data", default="data/snapshots", type=Path)
    parser.add_argument("--reports", default="reports", type=Path)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    sources = list(SOURCES.values()) if args.all else [get_source(args.source)]
    runs = run_all(sources, args.data, args.reports)

    print()
    for r in runs:
        status = "OK    " if r.ok else "FAILED"
        print(f"  {status} {r.source_id:<24} rows {r.rows:>9,}  {r.message if not r.ok else ''}")
    sys.exit(0 if all(r.ok for r in runs) else 1)


if __name__ == "__main__":
    main()
