"""Print a quick health report of a saved snapshot.

Usage:
    python scripts/inspect_snapshot.py data/snapshots/central_hudson_ny_pv/2026-09-30.parquet
"""

import argparse
from pathlib import Path

import geopandas as gpd
import pandas as pd

KEY_FIELDS = ["Substation", "Feeder", "HCMin", "HCMax", "InstalledDER", "QUEUEDDER"]
DATE_FIELDS = ["HCA_REFRESH_DATE", "DG_ConQue_REFRESH_DATE"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    args = parser.parse_args()

    size_mb = args.path.stat().st_size / 1_000_000
    gdf = gpd.read_parquet(args.path)

    print(f"File        : {args.path}")
    print(f"File size   : {size_mb:.1f} MB")
    print(f"Rows        : {len(gdf):,}")
    print(f"Columns     : {len(gdf.columns)}")
    print(f"CRS         : EPSG:{gdf.crs.to_epsg()}" if gdf.crs else "CRS         : MISSING")
    print(f"Geometry    : {gdf.geom_type.value_counts().to_dict()}")
    print(f"Empty shapes: {int(gdf.geometry.is_empty.sum() + gdf.geometry.isna().sum()):,}")
    print(f"Bounds      : {[round(float(v), 4) for v in gdf.total_bounds]}")

    print("\nKey fields (missing values / min / max):")
    for field in KEY_FIELDS:
        if field not in gdf.columns:
            print(f"  {field:<14} NOT PRESENT")
            continue
        col = gdf[field]
        missing = int(col.isna().sum())
        if pd.api.types.is_numeric_dtype(col):
            print(f"  {field:<14} missing {missing:,}  min {col.min()}  max {col.max()}")
        else:
            print(f"  {field:<14} missing {missing:,}  unique values {col.nunique():,}")

    print("\nRefresh dates:")
    for field in DATE_FIELDS:
        if field not in gdf.columns:
            print(f"  {field:<24} NOT PRESENT")
            continue
        raw = gdf[field]
        if pd.api.types.is_datetime64_any_dtype(raw):
            dates = pd.to_datetime(raw, utc=True)
        else:
            dates = pd.to_datetime(raw, unit="ms", errors="coerce", utc=True)
        print(
            f"  {field:<24} missing {int(dates.isna().sum()):,}  "
            f"oldest {dates.min()}  newest {dates.max()}"
        )

    if "Feeder" in gdf.columns and "Phases" in gdf.columns:
        print("\nPhases by group (does the line belong to a feeder?):")
        has_feeder = gdf["Feeder"].notna()
        for label, mask in (("HAS feeder", has_feeder), ("NO feeder", ~has_feeder)):
            counts = gdf.loc[mask, "Phases"].value_counts(dropna=False)
            print(f"  {label} ({int(mask.sum()):,} rows):")
            for phase, count in counts.items():
                print(f"    Phases={phase!s:<8} {count:,}")


if __name__ == "__main__":
    main()
