"""Look deeper at the National Grid snapshot before writing new rules.

Checks:
  1. Are "missing" values hidden as empty text or zeros?
  2. Does the map color match the capacity number (using National Grid's own legend)?
  3. Is the total capacity equal to the smallest of the individual limits?

Usage:
    python scripts/investigate_national_grid.py data/snapshots/national_grid_ny_pv/2026-10-01.parquet
"""

import argparse
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd

# National Grid's legend, read from the layer's renderer on their ArcGIS server.
# Each entry: (lowest MW in this color band, color name)
COLOR_BANDS = [
    (0.0, "brown"),
    (0.30, "red"),
    (0.50, "yellow"),
    (1.0, "green"),
    (1.50, "turquoise"),
    (2.0, "light blue"),
    (3.0, "blue"),
    (5.0, "dark blue"),
]

LIMIT_COLUMNS = [
    "primary_hc_over_voltage",
    "primary_hc_voltage_deviation",
    "primary_hc_regulator_deviation",
    "primary_hc_thermal_from_gen",
    "primary_hc_anti_islanding",
    "primary_hc_flicker",
]


def expected_color(mw: float) -> str | None:
    if pd.isna(mw) or mw < 0:
        return None
    color = None
    for lower, name in COLOR_BANDS:
        if mw >= lower:
            color = name
    return color


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    gdf = gpd.read_parquet(args.path)
    print(f"Rows: {len(gdf):,}")

    print("\n1) Hidden missing values")
    for col in ["feeder_cdf", "ID", "color"]:
        text = gdf[col].astype("string")
        blank = int(text.isna().sum())
        empty = int((text.str.strip() == "").sum())
        print(f"   {col:<12} blank {blank:,}   empty text {empty:,}   unique {text.nunique():,}")
    hc = gdf["primary_hc"]
    print(f"   primary_hc   blank {int(hc.isna().sum()):,}   exactly 0 {int((hc == 0).sum()):,}   "
          f"min {hc.min()}   median {hc.median()}   max {hc.max()}")

    print("\n2) Map color vs capacity number")
    print("   Colors used:", gdf["color"].value_counts(dropna=False).to_dict())
    expected = gdf["primary_hc"].map(expected_color)
    actual = gdf["color"].astype("string").str.strip().str.lower()
    comparable = expected.notna() & actual.notna()
    mismatch = comparable & (expected != actual)
    print(f"   Comparable rows: {int(comparable.sum()):,}   Mismatches: {int(mismatch.sum()):,}")
    if mismatch.any():
        sample = gdf.loc[mismatch, ["OBJECTID", "primary_hc", "color"]].assign(expected=expected[mismatch])
        print("   Examples:")
        print(sample.head(8).to_string(index=False))
        boundary = mismatch & gdf["primary_hc"].round(2).isin([b for b, _ in COLOR_BANDS])
        print(f"   Of the mismatches, exactly on a band edge (like 5.0): {int(boundary.sum()):,}")

    print("\n3) Total capacity vs smallest individual limit")
    present = [c for c in LIMIT_COLUMNS if c in gdf.columns]
    limits = gdf[present]
    smallest = limits.min(axis=1, skipna=True)
    usable = gdf["primary_hc"].notna() & smallest.notna()
    equal = usable & np.isclose(gdf["primary_hc"], smallest, atol=0.005)
    print(f"   Rows with total and limits: {int(usable.sum()):,}")
    print(f"   Total equals smallest limit: {int(equal.sum()):,} "
          f"({100 * equal.sum() / max(usable.sum(), 1):.2f}%)")
    differ = usable & ~equal
    if differ.any():
        diff = (gdf.loc[differ, "primary_hc"] - smallest[differ])
        print(f"   Differ: {int(differ.sum()):,}   total ABOVE smallest: {int((diff > 0).sum()):,}   "
              f"total BELOW smallest: {int((diff < 0).sum()):,}")
        sample = gdf.loc[differ, ["OBJECTID", "primary_hc"] + present].head(5)
        print("   Examples:")
        print(sample.to_string(index=False))


if __name__ == "__main__":
    main()
