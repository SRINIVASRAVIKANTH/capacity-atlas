"""Registry of every utility data source the project collects from.

Adding a new utility later means adding one entry here, not writing new code.

Sources we checked and do NOT collect from (kept here so the decision is documented):
  - Eversource CT EV hosting capacity: a firewall rejects requests larger than a few
    features, so bulk collection would mean ~130,000 requests per run. We respect that.
  - ORNL Open Energy Hub copy of the Eversource dataset: catalog entry only, 0 records.
"""

from dataclasses import dataclass

from capacity_atlas.schema import ColumnMap


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
    columns: ColumnMap | None = None  # which of this utility's columns means what


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
        columns=ColumnMap(
            record_id="OBJECTID",
            feeder="Feeder",
            substation="Substation",
            phases="Phases",
            capacity_mw="HCMin",
            capacity_max_mw="HCMax",
            analysis_date="HCA_REFRESH_DATE",
            der_added_since_analysis_mw="DG_INST_LASTHCA",
        ),
    ),
    "national_grid_ny_pv": Source(
        source_id="national_grid_ny_pv",
        utility="National Grid",
        state="NY",
        capacity_type="generation",
        layer_url=(
            "https://systemdataportal.nationalgrid.com/arcgis/rest/services/"
            "NYSDP/Hosting_Capacity_Data/MapServer/2"
        ),
        description="National Grid New York primary level PV hosting capacity by line section (MW).",
        batch_size=1000,  # layer allows 2000; confirm with the diagnose script before collecting
        columns=ColumnMap(
            record_id="OBJECTID",
            feeder="feeder_cdf",
            capacity_mw="primary_hc",
            limit_columns=(
                "primary_hc_over_voltage",
                "primary_hc_voltage_deviation",
                "primary_hc_regulator_deviation",
                "primary_hc_thermal_from_gen",
                "primary_hc_anti_islanding",
                "primary_hc_flicker",
            ),
            map_color="color",
            # Legend read from the layer's renderer on National Grid's ArcGIS server.
            color_bands=(
                (0.0, "brown"),
                (0.30, "red"),
                (0.50, "yellow"),
                (1.0, "green"),
                (1.50, "turquoise"),
                (2.0, "light blue"),
                (3.0, "blue"),
                (5.0, "dark blue"),
            ),
        ),
    ),
}


def get_source(source_id: str) -> Source:
    """Look up a source by id, with a clear error if it does not exist."""
    try:
        return SOURCES[source_id]
    except KeyError:
        available = ", ".join(sorted(SOURCES))
        raise KeyError(f"Unknown source '{source_id}'. Available: {available}") from None
