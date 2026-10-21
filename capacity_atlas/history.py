"""Capacity history: how each feeder's capacity moves from one weekly snapshot to the next.

The map shows only the latest week. This keeps, for every feeder, its highest published
hosting capacity on each snapshot date, so the web map can draw a small trend in the
feeder's card. Highest, because that is the best spot a project could find on the feeder.

One small JSON file holds it all. It lives in the repository under reports/history/, so every
week's version is kept in git, and a copy is uploaded next to the map data for the website.
Most feeders keep the same value for weeks, so each feeder stores only the dates where its
value changed, as [date index, value] pairs; a value holds until the next pair. That keeps the
file near 40 KB however many weeks it covers.

    {"generated_utc": "...", "metric": "highest_mw",
     "sources": {"national_grid_ny_pv": {"dates": ["2026-10-02", "2026-10-09", ...],
                                         "feeders": {"36_30_28858": [[0, 6.0], [1, 4.8]]}}}}

null means the feeder had no published value from that date on.

Usage (the weekly run does this):
    python -m capacity_atlas.history --data data/snapshots --previous data/previous data/history-src \
        --out reports/history/feeder_capacity.json
"""

from __future__ import annotations

import argparse
import json
import logging
import math
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from capacity_atlas.snapshot import SnapshotStore, replace_atomically
from capacity_atlas.sources import SOURCES, Source

logger = logging.getLogger(__name__)

MAX_DATES = 104  # two years of weekly points; older ones are dropped from the web file


class FeederHistory:
    """Per-source dates and, per feeder, its highest capacity on each date."""

    def __init__(self, sources: dict[str, dict] | None = None) -> None:
        self.sources: dict[str, dict] = sources or {}

    # ---------- reading and writing ----------
    @classmethod
    def load(cls, path: Path) -> FeederHistory:
        """The saved history, or an empty one if there is none yet or the file is unreadable."""
        if not path.exists():
            return cls()
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            sources = {}
            for source_id, entry in data["sources"].items():
                dates = [str(d) for d in entry["dates"]]
                if dates != sorted(set(dates)):
                    raise ValueError("dates are not in order")
                feeders = {str(k): expand(v, len(dates)) for k, v in entry["feeders"].items()}
                sources[source_id] = {"dates": dates, "feeders": feeders}
            return cls(sources)
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            # Never lose the run over a damaged file: start again and rebuild from the snapshots.
            logger.warning("Ignoring unreadable history file %s: %s", path, exc)
            return cls()

    def save(self, path: Path, generated: datetime | None = None) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "generated_utc": (generated or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "metric": "highest_mw",
            "sources": {source_id: {"dates": e["dates"],
                                    "feeders": {k: compress(v) for k, v in sorted(e["feeders"].items())}}
                        for source_id, e in self.sources.items()},
        }
        # Compact: the website downloads it, and one line per source keeps git diffs readable.
        text = "{\n" + ",\n".join(
            f"{json.dumps(k)}: {json.dumps(v, separators=(',', ':'))}" for k, v in payload.items()
        ) + "\n}\n"
        replace_atomically(path, lambda tmp: tmp.write_text(text, encoding="utf-8"))
        return path

    # ---------- adding a snapshot ----------
    def dates(self, source_id: str) -> list[str]:
        return list(self.sources.get(source_id, {}).get("dates", []))

    def add(self, source_id: str, day: str, highest: dict[str, float | None]) -> None:
        """Record one snapshot date. Adding a date that is already there replaces it."""
        entry = self.sources.setdefault(source_id, {"dates": [], "feeders": {}})
        dates, feeders = entry["dates"], entry["feeders"]
        if day in dates:
            i = dates.index(day)
            for name in feeders:
                feeders[name][i] = None
        else:
            i = sum(d < day for d in dates)  # keep dates in order, even when backfilling
            dates.insert(i, day)
            for values in feeders.values():
                values.insert(i, None)
        for name, value in highest.items():
            if name not in feeders:
                feeders[name] = [None] * len(dates)
            feeders[name][i] = value
        self.trim(source_id)

    def trim(self, source_id: str, keep: int = MAX_DATES) -> None:
        entry = self.sources[source_id]
        drop = len(entry["dates"]) - keep
        if drop <= 0:
            return
        entry["dates"] = entry["dates"][drop:]
        for name in list(entry["feeders"]):
            values = entry["feeders"][name][drop:]
            if all(v is None for v in values):
                del entry["feeders"][name]  # a feeder gone for two years leaves the file
            else:
                entry["feeders"][name] = values


def compress(values: list[float | None]) -> list[list]:
    """[6.0, 6.0, 4.8, 4.8] -> [[0, 6.0], [2, 4.8]]: only where the value changes."""
    points, last = [], object()
    for i, value in enumerate(values):
        if value != last:
            points.append([i, value])
            last = value
    return points


def expand(points: list, length: int) -> list[float | None]:
    """The opposite of compress(); rejects pairs that are out of order or out of range."""
    values: list[float | None] = [None] * length
    previous = -1
    for pair in points:
        i, value = pair
        if not isinstance(i, int) or not previous < i < length or not (value is None or isinstance(value, (int, float))):
            raise ValueError(f"bad history point {pair!r}")
        for j in range(i, length):
            values[j] = None if value is None else float(value)
        previous = i
    return values


def highest_by_feeder(frame: pd.DataFrame, source: Source) -> dict[str, float | None]:
    """Each feeder's highest published capacity in one snapshot, in MW rounded to 2 decimals."""
    c = source.columns
    if c is None or not c.capacity_mw or c.feeder not in frame.columns or c.capacity_mw not in frame.columns:
        return {}
    feeder = frame[c.feeder].astype("string")  # the same text the map tiles use
    capacity = pd.to_numeric(frame[c.capacity_mw], errors="coerce")
    highest = capacity.groupby(feeder).max()
    out: dict[str, float | None] = {}
    for name, value in highest.items():
        if str(name).strip() == "":
            continue  # sections without a feeder name have no feeder to chart
        out[str(name)] = None if value is None or (isinstance(value, float) and math.isnan(value)) else round(float(value), 2)
    return out


def read_snapshot(path: Path, source: Source) -> pd.DataFrame:
    """Only the two columns history needs, so even large snapshots read quickly."""
    c = source.columns
    wanted = [col for col in (c.feeder, c.capacity_mw) if col]
    return pd.read_parquet(path, columns=wanted)


def update(history: FeederHistory, stores: list[SnapshotStore]) -> list[str]:
    """Add every snapshot date the history does not have yet. Returns what was added."""
    added = []
    for source_id, source in SOURCES.items():
        found: dict[str, Path] = {}
        for store in stores:
            found.update(store.by_date(source_id))
        known = set(history.dates(source_id))
        for day in sorted(set(found) - known):
            try:
                highest = highest_by_feeder(read_snapshot(found[day], source), source)
            except Exception:  # one damaged file costs one point on the chart, nothing more
                logger.exception("Could not read %s for the history", found[day])
                continue
            history.add(source_id, day, highest)
            added.append(f"{source_id} {day}")
            logger.info("History: %s %s, %d feeders", source_id, day, len(highest))
    return added


def main() -> None:
    parser = argparse.ArgumentParser(description="Add new snapshot dates to the feeder capacity history.")
    parser.add_argument("--data", default="data/snapshots", type=Path, help="This run's snapshots")
    parser.add_argument("--previous", nargs="*", default=[], type=Path,
                        help="Folders of snapshots downloaded from earlier releases")
    parser.add_argument("--out", default="reports/history/feeder_capacity.json", type=Path)
    parser.add_argument("--known-dates", action="store_true",
                        help="Print source_date for every date already in the history, then stop")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    history = FeederHistory.load(args.out)
    if args.known_dates:
        for source_id in SOURCES:
            for day in history.dates(source_id):
                print(f"{source_id}_{day}")
        return
    stores = [SnapshotStore(args.data, folder) for folder in args.previous] or [SnapshotStore(args.data)]
    added = update(history, stores)
    history.save(args.out)
    print(f"History: {len(added)} new snapshot dates added, saved to {args.out}")


if __name__ == "__main__":
    main()
