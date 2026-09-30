"""Investigate rows that have a shape but no feeder.

Answers three questions:
  1. Which columns (if any) still have values in those rows?
  2. How long are those lines compared to normal lines?
  3. Are they exact duplicates of lines that DO have data?

Usage:
    python scripts/investigate_empty_rows.py data/snapshots/central_hudson_ny_pv/2026-09-30.parquet
"""

import argparse
from pathlib import Path

import geopandas as gpd


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    args = parser.parse_args()

    gdf = gpd.read_parquet(args.path)
    empty = gdf[gdf["Feeder"].isna()]
    full = gdf[gdf["Feeder"].notna()]
    print(f"Rows WITH feeder: {len(full):,}   Rows WITHOUT feeder: {len(empty):,}")

    print("\n1) Columns that still have values in the no-feeder rows:")
    attribute_columns = [c for c in gdf.columns if c != "geometry"]
    found_any = False
    for column in attribute_columns:
        filled = int(empty[column].notna().sum())
        if filled:
            found_any = True
            sample = empty[column].dropna().astype(str).unique()[:3]
            print(f"   {column:<24} filled in {filled:,} rows   examples: {list(sample)}")
    if not found_any:
        print("   None. These rows contain only a shape.")

    print("\n2) Line length (Shape__Length, in the layer's units):")
    if "Shape__Length" in gdf.columns:
        for label, part in (("WITH feeder", full), ("WITHOUT feeder", empty)):
            length = part["Shape__Length"]
            print(
                f"   {label:<15} median {length.median():,.1f}   "
                f"min {length.min():,.1f}   max {length.max():,.1f}"
            )
    else:
        print("   Shape__Length column not present.")

    print("\n3) Exact duplicate shapes:")
    full_shapes = set(full.geometry.to_wkb(hex=True))
    empty_shapes = empty.geometry.to_wkb(hex=True)
    matches = int(empty_shapes.isin(full_shapes).sum())
    print(f"   No-feeder lines identical to a line that HAS data: {matches:,} of {len(empty):,}")
    print(f"   Duplicate shapes inside the no-feeder group:        {int(empty_shapes.duplicated().sum()):,}")
    print(f"   Duplicate shapes inside the with-feeder group:      "
          f"{int(full.geometry.to_wkb(hex=True).duplicated().sum()):,}")


if __name__ == "__main__":
    main()
