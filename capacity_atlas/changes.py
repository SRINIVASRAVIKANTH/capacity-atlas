"""The time machine: compare two snapshots of the same source, line section by line section.

Line sections are matched by the utility's own section ID (ColumnMap.section_key), not by
OBJECTID, because OBJECTID is only a row number and can be renumbered when a layer is
republished. If a section ID appears more than once, each copy gets an occurrence number
(ID#0, ID#1, ...) so the comparison stays one to one.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd

from capacity_atlas.quality.rules import to_utc_datetime
from capacity_atlas.schema import ColumnMap

TOLERANCE_MW = 0.005  # published values are rounded to 2 decimals


@dataclass
class ChangeSummary:
    source_id: str
    old_snapshot: str
    new_snapshot: str
    old_rows: int
    new_rows: int
    added: int = 0
    removed: int = 0
    geometry_changed: int = 0
    capacity_increased: int = 0
    capacity_decreased: int = 0
    newly_analyzed: int = 0
    analysis_removed: int = 0
    feeders_refreshed: int = 0
    other_attributes_changed: int = 0
    most_changed_columns: dict = field(default_factory=dict)
    feeders_losing_capacity: list = field(default_factory=list)
    examples: dict = field(default_factory=dict)

    @property
    def anything_changed(self) -> bool:
        return any([self.added, self.removed, self.geometry_changed, self.capacity_increased,
                    self.capacity_decreased, self.newly_analyzed, self.analysis_removed,
                    self.feeders_refreshed, self.other_attributes_changed])


def keyed(gdf: gpd.GeoDataFrame, key: str) -> gpd.GeoDataFrame:
    """Index rows by section ID, numbering repeated IDs so every key is unique."""
    ids = gdf[key].astype("string").fillna("<missing>")
    occurrence = ids.groupby(ids).cumcount().astype("string")
    out = gdf.copy()
    out.index = (ids + "#" + occurrence).rename("section")
    return out


def _examples(index: pd.Index, n: int = 5) -> list[str]:
    return [str(x) for x in index[:n]]


def compare(
    old: gpd.GeoDataFrame,
    new: gpd.GeoDataFrame,
    columns: ColumnMap,
    source_id: str,
    old_name: str,
    new_name: str,
    top_feeders: int = 10,
) -> ChangeSummary:
    if not columns.section_key:
        raise ValueError(f"Source '{source_id}' has no section_key; cannot compare snapshots.")
    key = columns.section_key
    for label, frame in (("old", old), ("new", new)):
        if key not in frame.columns:
            raise ValueError(f"Section ID column '{key}' is missing from the {label} snapshot.")
    a, b = keyed(old, key), keyed(new, key)
    summary = ChangeSummary(source_id, old_name, new_name, len(old), len(new))

    added = b.index.difference(a.index)
    removed = a.index.difference(b.index)
    common = a.index.intersection(b.index)
    summary.added, summary.removed = len(added), len(removed)
    summary.examples["added"] = _examples(added)
    summary.examples["removed"] = _examples(removed)

    a, b = a.loc[common], b.loc[common]

    geom_changed = a.geometry.to_wkb(hex=True) != b.geometry.to_wkb(hex=True)
    summary.geometry_changed = int(geom_changed.sum())
    summary.examples["geometry_changed"] = _examples(common[geom_changed.to_numpy()])

    if columns.capacity_mw:
        old_cap, new_cap = a[columns.capacity_mw], b[columns.capacity_mw]
        both = old_cap.notna() & new_cap.notna()
        delta = (new_cap - old_cap).where(both)
        up = both & (delta > TOLERANCE_MW)
        down = both & (delta < -TOLERANCE_MW)
        newly = old_cap.isna() & new_cap.notna()
        gone = old_cap.notna() & new_cap.isna()
        summary.capacity_increased, summary.capacity_decreased = int(up.sum()), int(down.sum())
        summary.newly_analyzed, summary.analysis_removed = int(newly.sum()), int(gone.sum())
        summary.examples["capacity_increased"] = _examples(common[up.to_numpy()])
        summary.examples["capacity_decreased"] = _examples(common[down.to_numpy()])

        if down.any() and columns.feeder in b.columns:
            per_feeder = (
                pd.DataFrame({"feeder": b.loc[down, columns.feeder], "delta": delta[down]})
                .groupby("feeder")["delta"]
                .agg(sections="size", largest_drop_mw="min", median_change_mw="median")
                .sort_values(["sections", "largest_drop_mw"], ascending=[False, True])
                .head(top_feeders)
                .reset_index()
            )
            summary.feeders_losing_capacity = [
                {k: (round(float(v), 3) if isinstance(v, (float, np.floating)) else
                     int(v) if isinstance(v, (int, np.integer)) else str(v))
                 for k, v in row.items()}
                for row in per_feeder.to_dict("records")
            ]

    if columns.analysis_date and columns.feeder in b.columns:
        old_date = to_utc_datetime(a[columns.analysis_date])
        new_date = to_utc_datetime(b[columns.analysis_date])
        refreshed = new_date.notna() & (old_date.isna() | (new_date > old_date))
        summary.feeders_refreshed = int(b.loc[refreshed, columns.feeder].nunique())

    skip = {"geometry", key, columns.capacity_mw, columns.analysis_date}
    others = [c for c in a.columns if c in b.columns and c not in skip]
    changed_any = pd.Series(False, index=common)
    counts = {}
    for c in others:
        x, y = a[c], b[c]
        diff = ~((x == y) | (x.isna() & y.isna()))
        diff = diff.fillna(True).astype(bool)
        if diff.any():
            counts[c] = int(diff.sum())
            changed_any |= diff
    summary.other_attributes_changed = int(changed_any.sum())
    summary.most_changed_columns = dict(sorted(counts.items(), key=lambda kv: -kv[1])[:10])
    return summary


def write_change_report(summary: ChangeSummary, out_dir: Path) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{Path(summary.old_snapshot).stem}_to_{Path(summary.new_snapshot).stem}"
    json_path, md_path = out_dir / f"{stem}.json", out_dir / f"{stem}.md"
    json_path.write_text(json.dumps(asdict(summary), indent=2), encoding="utf-8")

    s = summary
    lines = [
        f"# Changes: {s.source_id}",
        "",
        f"From `{s.old_snapshot}` ({s.old_rows:,} rows) to `{s.new_snapshot}` ({s.new_rows:,} rows)",
        "",
    ]
    if not s.anything_changed:
        lines += ["No changes. The published data is identical to the previous snapshot."]
    else:
        lines += [
            "| Change | Line sections |",
            "|---|---:|",
            f"| Added | {s.added:,} |",
            f"| Removed | {s.removed:,} |",
            f"| Shape changed | {s.geometry_changed:,} |",
            f"| Capacity increased | {s.capacity_increased:,} |",
            f"| Capacity decreased | {s.capacity_decreased:,} |",
            f"| Newly analyzed | {s.newly_analyzed:,} |",
            f"| Analysis removed | {s.analysis_removed:,} |",
            f"| Other attributes changed | {s.other_attributes_changed:,} |",
            "",
            f"Feeders whose analysis was refreshed: {s.feeders_refreshed:,}",
        ]
        if s.feeders_losing_capacity:
            lines += ["", "## Feeders with the most sections losing capacity", "",
                      "| Feeder | Sections | Largest drop (MW) | Median change (MW) |",
                      "|---|---:|---:|---:|"]
            for f in s.feeders_losing_capacity:
                lines.append(f"| {f['feeder']} | {f['sections']:,} | {f['largest_drop_mw']} | "
                             f"{f['median_change_mw']} |")
        if s.most_changed_columns:
            lines += ["", "## Other columns that changed", "", "| Column | Sections |", "|---|---:|"]
            lines += [f"| {c} | {n:,} |" for c, n in s.most_changed_columns.items()]
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return json_path, md_path
