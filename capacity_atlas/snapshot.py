"""Save each download as a dated snapshot. This is the start of the time machine."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import geopandas as gpd

from capacity_atlas.sources import Source


def save_snapshot(
    gdf: gpd.GeoDataFrame,
    source: Source,
    root: Path,
    fetched_at: datetime,
) -> Path:
    """Write data/snapshots/<source_id>/<YYYY-MM-DD>.parquet plus a metadata file."""
    folder = root / source.source_id
    folder.mkdir(parents=True, exist_ok=True)

    stem = fetched_at.strftime("%Y-%m-%d")
    data_path = folder / f"{stem}.parquet"
    meta_path = folder / f"{stem}.meta.json"

    gdf.to_parquet(data_path, index=False)
    meta = {
        "source_id": source.source_id,
        "utility": source.utility,
        "state": source.state,
        "capacity_type": source.capacity_type,
        "layer_url": source.layer_url,
        "fetched_at_utc": fetched_at.isoformat(),
        "feature_count": int(len(gdf)),
        "columns": [c for c in gdf.columns if c != "geometry"],
    }
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return data_path
