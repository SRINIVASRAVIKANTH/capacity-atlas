"""Check how an ArcGIS layer responds before collecting from it.

Usage:
    python scripts/diagnose_arcgis.py --source central_hudson_ny_pv

Sends a handful of small, spaced-out test requests and prints exactly what comes back.
"""

import argparse
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from capacity_atlas.sources import SOURCES, get_source  # noqa: E402

HEADERS = {"User-Agent": "capacity-atlas/0.1 (open-source research project)"}


def report(label: str, response: requests.Response, seconds: float) -> None:
    body = response.text[:200].replace("\n", " ").strip() or "<empty body>"
    print(f"\n=== {label} ===")
    print(f"HTTP status : {response.status_code}")
    print(f"Content-Type: {response.headers.get('Content-Type', 'unknown')}")
    print(f"Size        : {len(response.content):,} bytes")
    print(f"Time        : {seconds:.1f} s")
    print(f"Body starts : {body}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, choices=sorted(SOURCES))
    args = parser.parse_args()
    source = get_source(args.source)
    query_url = f"{source.layer_url}/query"

    print(f"Source: {source.utility} ({source.source_id})")
    print("Getting object IDs...")
    ids_response = requests.post(
        query_url,
        data={"where": "1=1", "returnIdsOnly": "true", "f": "json"},
        headers=HEADERS,
        timeout=120,
    )
    ids = sorted(ids_response.json()["objectIds"])
    print(f"Total IDs: {len(ids):,}")

    for size in (5, 100, source.batch_size):
        time.sleep(1)
        params = {
            "objectIds": ",".join(str(i) for i in ids[:size]),
            "outFields": "*",
            "returnGeometry": "true",
            "outSR": "4326",
            "f": "geojson",
        }
        start = time.time()
        try:
            response = requests.post(query_url, data=params, headers=HEADERS, timeout=120)
            report(f"POST geojson, {size} features", response, time.time() - start)
        except requests.RequestException as exc:
            print(f"\n=== {size} features ===\nREQUEST FAILED: {exc!r}")


if __name__ == "__main__":
    main()
