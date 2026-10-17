"""What stops a line section from taking more solar.

Some utilities publish, next to the total hosting capacity, the value each separate
engineering criterion allows (voltage, overload, flicker and so on). The total is the lowest
of them, so the criterion with the lowest value is the one that limits the line. Knowing
which one tells a developer what kind of upgrade or project design could help.

Each criterion has a fixed bit. A section can be limited by more than one criterion at
the same value, so the tiles store a bit mask ("lf"), and summary.json carries the words
for each bit.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from capacity_atlas.quality.rules import TOLERANCE_MW


@dataclass(frozen=True)
class LimitKind:
    kind: str
    bit: int
    title: str
    explanation: str


# Only ever ADD new kinds at the end with the next free bit; the web map reads old tiles too.
LIMIT_KINDS: tuple[LimitKind, ...] = (
    LimitKind("over_voltage", 1, "Voltage rise",
              "More solar would push the voltage on this line above the allowed range."),
    LimitKind("voltage_deviation", 2, "Voltage swings",
              "The voltage would jump too far when solar output drops or returns suddenly, "
              "for example as clouds pass."),
    LimitKind("regulator_deviation", 4, "Voltage regulator swings",
              "Those swings would make the line's voltage regulators adjust far more often "
              "than they are designed to."),
    LimitKind("thermal", 8, "Overload",
              "The power from more solar would carry a wire or transformer past its rating."),
    LimitKind("anti_islanding", 16, "Islanding risk",
              "Solar would be large compared with the lowest local demand, so it might keep "
              "a cut-off part of the line powered during an outage."),
    LimitKind("flicker", 32, "Flicker",
              "Quick changes in solar output could make lights flicker for nearby customers."),
)
LIMIT_BIT = {k.kind: k.bit for k in LIMIT_KINDS}


def limit_legend() -> list[dict]:
    """The words for every bit, for summary.json."""
    return [k.__dict__.copy() for k in LIMIT_KINDS]


def limiting_factors(
    gdf: pd.DataFrame,
    capacity: str,
    columns: tuple[str, ...],
    kinds: tuple[str, ...],
    ceiling_mw: float | None = None,
) -> pd.Series:
    """Bit mask of the criteria that set each section's capacity, or <NA> where none does.

    <NA> when the section has no criteria values, when the published total is not the lowest
    criterion (an unpublished constraint is at work; a quality check reports that), or when
    the lowest criterion is at the utility's study ceiling, which means "at least this much"
    rather than a real limit.
    """
    unknown = sorted(set(kinds) - set(LIMIT_BIT))
    if unknown:
        raise ValueError(f"Unknown limit kind(s): {', '.join(unknown)}")
    if len(columns) != len(kinds):
        raise ValueError("Each limit column needs exactly one limit kind.")
    present = [(c, k) for c, k in zip(columns, kinds, strict=True) if c in gdf.columns]
    if not present or capacity not in gdf.columns:
        return pd.Series(pd.NA, index=gdf.index, dtype="Int64")

    values = pd.DataFrame({c: pd.to_numeric(gdf[c], errors="coerce") for c, _ in present})
    lowest = values.min(axis=1, skipna=True)
    total = pd.to_numeric(gdf[capacity], errors="coerce")
    sets_total = (total - lowest).abs() <= TOLERANCE_MW
    if ceiling_mw is not None:
        sets_total &= lowest < ceiling_mw - TOLERANCE_MW

    mask = np.zeros(len(gdf), dtype=np.int64)
    for column, kind in present:
        at_lowest = (values[column] <= lowest + TOLERANCE_MW).fillna(False).to_numpy()
        mask[at_lowest] |= LIMIT_BIT[kind]
    return pd.Series(mask, index=gdf.index, dtype="Int64").where(sets_total.fillna(False))
