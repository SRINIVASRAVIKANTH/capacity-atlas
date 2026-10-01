"""Maps each utility's own column names to the names our code uses.

Utilities name the same idea differently ("Feeder", "CIRCUIT_NAME", ...).
Rules are written once against these standard names, and each source says
which of its columns means what.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class ColumnMap:
    record_id: str
    feeder: str
    substation: str | None = None
    phases: str | None = None
    capacity_min_mw: str | None = None
    capacity_max_mw: str | None = None
    analysis_date: str | None = None
    der_added_since_analysis_mw: str | None = None
