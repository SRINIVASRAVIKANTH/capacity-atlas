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
    section_key: str | None = None  # the utility's own stable ID for a line section
    substation: str | None = None
    phases: str | None = None
    capacity_mw: str | None = None  # main published hosting capacity value (MW)
    capacity_max_mw: str | None = None  # upper value, only if the utility publishes a range
    analysis_date: str | None = None
    der_added_since_analysis_mw: str | None = None
    # Individual limits whose minimum should bound the total (e.g. thermal, voltage, flicker)
    limit_columns: tuple[str, ...] = ()
    # Map color column and the utility's legend: ((lowest MW of band, color name), ...)
    map_color: str | None = None
    color_bands: tuple[tuple[float, str], ...] = ()
