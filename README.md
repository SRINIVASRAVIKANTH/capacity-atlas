# Capacity Atlas

Utility hosting capacity data, combined, tracked over time, and checked for mistakes.

**Status:** early development. The first data source is working.

## What it does today

- Downloads the full hosting capacity layer from a utility's public ArcGIS service
- Saves each download as a dated GeoParquet snapshot (the start of the history tracker)
- Stops and reports clearly if the server returns anything unexpected

## Data sources

| Source | Utility | State | Features | Status |
|---|---|---|---|---|
| `central_hudson_ny_pv` | Central Hudson Gas & Electric | NY | 306,419 line sections | Working |

Sources we checked but do not collect from are documented in `capacity_atlas/sources.py`, with the reason.

## Setup (Windows, Anaconda)

```
conda create -n capacity-atlas python=3.12 -y
conda activate capacity-atlas
pip install -r requirements.txt
pytest
```

## Usage

```
python -m capacity_atlas.cli --source central_hudson_ny_pv
python scripts/inspect_snapshot.py data/snapshots/central_hudson_ny_pv/<date>.parquet
```

## Note on the data

Hosting capacity values are estimates published by each utility. They are not a substitute for a formal interconnection study.
