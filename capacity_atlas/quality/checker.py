"""Runs quality rules on a snapshot and writes a report."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

import geopandas as gpd

from capacity_atlas.quality.rules import ERROR, INFO, WARNING, QualityRule

SEVERITY_ORDER = {ERROR: 0, WARNING: 1, INFO: 2}
SEVERITY_ICON = {ERROR: "ERROR", WARNING: "WARNING", INFO: "INFO"}


@dataclass
class RuleResult:
    rule_id: str
    title: str
    severity: str
    explanation: str
    status: str  # "ran" or "skipped"
    flagged: int
    total: int
    percent: float
    example_ids: list

    @property
    def passed(self) -> bool:
        return self.status == "ran" and self.flagged == 0


class QualityChecker:
    def __init__(self, rules: list[QualityRule], record_id: str, max_examples: int = 5):
        self.rules = rules
        self.record_id = record_id
        self.max_examples = max_examples

    def run(self, gdf: gpd.GeoDataFrame) -> list[RuleResult]:
        results = []
        total = len(gdf)
        for rule in self.rules:
            missing = [c for c in rule.required_columns() if c not in gdf.columns]
            if missing:
                results.append(RuleResult(rule.rule_id, rule.title, rule.severity,
                                          f"Skipped: columns not found {missing}",
                                          "skipped", 0, total, 0.0, []))
                continue
            flags = rule.check(gdf)
            if len(flags) != total:
                raise ValueError(f"Rule {rule.rule_id} returned {len(flags)} values for {total} rows")
            flagged = int(flags.sum())
            examples = []
            if flagged and self.record_id in gdf.columns:
                examples = [int(x) if hasattr(x, "__int__") else str(x)
                            for x in gdf.loc[flags, self.record_id].head(self.max_examples)]
            percent = round(100 * flagged / total, 2) if total else 0.0
            results.append(RuleResult(rule.rule_id, rule.title, rule.severity, rule.explanation,
                                      "ran", flagged, total, percent, examples))
        return sorted(results, key=lambda r: (SEVERITY_ORDER.get(r.severity, 9), -r.flagged))


def write_reports(results: list[RuleResult], snapshot_path: Path, source_id: str) -> tuple[Path, Path]:
    """Save <snapshot>.quality.json (for code) and <snapshot>.quality.md (for people)."""
    stem = snapshot_path.with_suffix("")
    json_path = Path(f"{stem}.quality.json")
    md_path = Path(f"{stem}.quality.md")

    json_path.write_text(json.dumps(
        {"source_id": source_id, "snapshot": snapshot_path.name,
         "results": [asdict(r) for r in results]}, indent=2), encoding="utf-8")

    total = results[0].total if results else 0
    lines = [f"# Data quality report: {source_id}", "",
             f"Snapshot: `{snapshot_path.name}`  ", f"Rows checked: {total:,}", "",
             "| Severity | Check | Flagged | % of rows | Example record IDs |",
             "|---|---|---:|---:|---|"]
    for r in results:
        if r.status == "skipped":
            lines.append(f"| {SEVERITY_ICON[r.severity]} | {r.title} | skipped | | |")
        else:
            ids = ", ".join(str(x) for x in r.example_ids) or "none"
            lines.append(f"| {SEVERITY_ICON[r.severity]} | {r.title} | {r.flagged:,} | {r.percent} | {ids} |")
    lines += ["", "Hosting capacity values are utility estimates. Flags mean 'worth checking', "
              "not proof of an error."]
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return json_path, md_path
