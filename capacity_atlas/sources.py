"""Registry of every utility data source the project collects from.

Adding a new utility later means adding one entry here, not writing new code.

Sources we checked and do NOT collect from (kept here so the decision is documented):
  - Eversource CT EV hosting capacity: a firewall rejects requests larger than a few
    features, so bulk collection would mean ~130,000 requests per run. We respect that.
  - ORNL Open Energy Hub copy of the Eversource dataset: catalog entry only, 0 records.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Source:
    """One public hosting capacity layer published by a utility."""

    source_id: str
    utility: str
    state: str
    capacity_type: str  # "load" (EV charging, new demand) or "generation" (solar, storage)
    layer_url: str
    description: str
    batch_size: int = 500  # features per request; must not exceed the layer's max record count
    pause_seconds: float = 0.5  # polite wait between requests so we never overload a server


SOURCES: dict[str, Source] = {
    "central_hudson_ny_pv": Source(
        source_id="central_hudson_ny_pv",
        utility="Central Hudson Gas & Electric",
        state="NY",
        capacity_type="generation",
        layer_url=(
            "https://services1.arcgis.com/CEN9MBRF2dIzEmKF/ArcGIS/rest/services/"
            "Hosting_Capacity_Stage3/FeatureServer/0"
        ),
        description="Central Hudson Stage 3 PV hosting capacity by line section (MW).",
        batch_size=1000,  # layer allows 2000; 1000 keeps each response a moderate size
    ),
}


def get_source(source_id: str) -> Source:
    """Look up a source by id, with a clear error if it does not exist."""
    try:
        return SOURCES[source_id]
    except KeyError:
        available = ", ".join(sorted(SOURCES))
        raise KeyError(f"Unknown source '{source_id}'. Available: {available}") from None
