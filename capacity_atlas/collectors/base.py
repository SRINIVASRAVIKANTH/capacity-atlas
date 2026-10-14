"""What every data collector must do, so the pipeline can run any of them the same way.

Today every utility publishes through ArcGIS REST. A utility that publishes a CSV download,
an open data portal or a different GIS server gets its own Collector subclass, and the
pipeline, checks, change reports and map keep working without changes.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

import geopandas as gpd


class CollectorError(RuntimeError):
    """Base class for every error a collector raises on purpose."""


class Collector(ABC):
    """Downloads one utility layer into a GeoDataFrame in WGS84 (EPSG:4326)."""

    @abstractmethod
    def collect(self) -> gpd.GeoDataFrame:
        """Return every feature of the layer. Raise a CollectorError when that is not possible."""
