"""Data quality rules.

Each rule looks at every row and answers one yes/no question:
"is this row suspicious?"  True means the row is flagged.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime

import geopandas as gpd
import pandas as pd

from capacity_atlas.schema import ColumnMap

ERROR = "error"      # logically impossible values
WARNING = "warning"  # likely a publishing mistake
INFO = "info"        # useful context, not a mistake


class QualityRule(ABC):
    """Base class. Every rule has an id, a title, a severity and a check."""

    rule_id: str
    title: str
    severity: str
    explanation: str

    def required_columns(self) -> list[str]:
        return []

    @abstractmethod
    def check(self, gdf: gpd.GeoDataFrame) -> pd.Series:
        """Return a True/False series, one value per row. True = flagged."""


class MissingWhenPresentRule(QualityRule):
    """Flags rows where column `present` has a value but column `missing` is empty."""

    def __init__(self, rule_id, title, severity, explanation, present: str, missing: str):
        self.rule_id = rule_id
        self.title = title
        self.severity = severity
        self.explanation = explanation
        self.present = present
        self.missing = missing

    def required_columns(self) -> list[str]:
        return [self.present, self.missing]

    def check(self, gdf):
        return gdf[self.present].notna() & gdf[self.missing].isna()


class MissingAnalysisRule(QualityRule):
    """Rows that have a shape but no feeder: no hosting capacity analysis published."""

    rule_id = "no_analysis_published"
    title = "Line section has no hosting capacity analysis"
    severity = INFO
    explanation = "Shown as 'no data' on the map. Coverage information, not an error."

    def __init__(self, feeder: str):
        self.feeder = feeder

    def required_columns(self):
        return [self.feeder]

    def check(self, gdf):
        return gdf[self.feeder].isna()


class DuplicateShapeRule(QualityRule):
    """Flags every row whose geometry is identical to another analyzed row."""

    rule_id = "duplicate_shape"
    title = "Same line section published more than once"
    severity = WARNING
    explanation = "Identical geometry appears in several rows."

    def __init__(self, feeder: str):
        self.feeder = feeder

    def required_columns(self):
        return [self.feeder]

    def check(self, gdf):
        analyzed = gdf[self.feeder].notna()
        shapes = gdf.geometry.to_wkb(hex=True)
        flagged = pd.Series(False, index=gdf.index)
        flagged[analyzed] = shapes[analyzed].duplicated(keep=False)
        return flagged


class ConflictingDuplicateRule(QualityRule):
    """Duplicate shapes whose capacity values disagree: two answers for one place."""

    rule_id = "duplicate_shape_conflicting_capacity"
    title = "Duplicate line sections report different capacity"
    severity = ERROR
    explanation = "The same place has two different hosting capacity values."

    def __init__(self, feeder: str, capacity: str):
        self.feeder = feeder
        self.capacity = capacity

    def required_columns(self):
        return [self.feeder, self.capacity]

    def check(self, gdf):
        analyzed = gdf[gdf[self.feeder].notna()]
        shapes = analyzed.geometry.to_wkb(hex=True)
        dup = shapes.duplicated(keep=False)
        flagged = pd.Series(False, index=gdf.index)
        if not dup.any():
            return flagged
        values = analyzed.loc[dup, self.capacity].round(6).astype("string").fillna("<missing>")
        distinct = values.groupby(shapes[dup]).transform("nunique")
        flagged[distinct.index] = distinct > 1
        return flagged


class MinAboveMaxRule(QualityRule):
    rule_id = "capacity_min_above_max"
    title = "Minimum capacity is greater than maximum capacity"
    severity = ERROR
    explanation = "Logically impossible."

    def __init__(self, cap_min: str, cap_max: str):
        self.cap_min = cap_min
        self.cap_max = cap_max

    def required_columns(self):
        return [self.cap_min, self.cap_max]

    def check(self, gdf):
        return (gdf[self.cap_min] > gdf[self.cap_max]).fillna(False).astype(bool)


class NegativeCapacityRule(QualityRule):
    rule_id = "capacity_negative"
    title = "Capacity value is negative"
    severity = ERROR
    explanation = "Hosting capacity cannot be below zero."

    def __init__(self, columns: list[str]):
        self.columns = columns

    def required_columns(self):
        return list(self.columns)

    def check(self, gdf):
        flagged = pd.Series(False, index=gdf.index)
        for column in self.columns:
            flagged |= (gdf[column] < 0).fillna(False).astype(bool)
        return flagged


def to_utc_datetime(series: pd.Series) -> pd.Series:
    """ArcGIS dates may arrive as milliseconds since 1970 or as real dates."""
    if pd.api.types.is_datetime64_any_dtype(series):
        return pd.to_datetime(series, utc=True)
    return pd.to_datetime(series, unit="ms", errors="coerce", utc=True)


class StaleAnalysisRule(QualityRule):
    """Analysis older than `max_age_days` while significant new DER was added since.

    Based on the New York Joint Utilities' stated practice of a six-month update
    for circuits whose connected DG grows by more than 500 kW.
    """

    rule_id = "stale_analysis_with_new_der"
    title = "Analysis older than 6 months with 0.5+ MW of new DER since"
    severity = WARNING
    explanation = "The published capacity may no longer reflect the circuit."

    def __init__(
        self,
        analysis_date: str,
        der_added: str,
        reference_date: datetime,
        max_age_days: int = 182,
        der_threshold_mw: float = 0.5,
    ):
        self.analysis_date = analysis_date
        self.der_added = der_added
        ref = pd.Timestamp(reference_date)
        self.reference_date = ref.tz_convert("UTC") if ref.tzinfo else ref.tz_localize("UTC")
        self.max_age_days = max_age_days
        self.der_threshold_mw = der_threshold_mw

    def required_columns(self):
        return [self.analysis_date, self.der_added]

    def check(self, gdf):
        dates = to_utc_datetime(gdf[self.analysis_date])
        age_days = (self.reference_date - dates).dt.days
        old = (age_days > self.max_age_days).fillna(False).astype(bool)
        grew = (gdf[self.der_added] > self.der_threshold_mw).fillna(False).astype(bool)
        return old & grew


def default_rules(columns: ColumnMap, reference_date: datetime) -> list[QualityRule]:
    """Build the standard rule set for a source, skipping rules it has no columns for."""
    c = columns
    rules: list[QualityRule] = [MissingAnalysisRule(c.feeder), DuplicateShapeRule(c.feeder)]

    if c.substation:
        rules.append(MissingWhenPresentRule(
            "feeder_without_substation", "Feeder listed but substation missing", WARNING,
            "Every feeder is served by a substation.", present=c.feeder, missing=c.substation))
        rules.append(MissingWhenPresentRule(
            "substation_without_feeder", "Substation listed but feeder missing", WARNING,
            "A substation value without a feeder is inconsistent.",
            present=c.substation, missing=c.feeder))
    if c.phases:
        rules.append(MissingWhenPresentRule(
            "feeder_without_phase", "Feeder listed but phase missing", WARNING,
            "Every energized line section has a phase.", present=c.feeder, missing=c.phases))
    if c.capacity_min_mw:
        rules.append(MissingWhenPresentRule(
            "feeder_without_capacity", "Feeder listed but capacity value missing", WARNING,
            "An analyzed feeder should have a result.",
            present=c.feeder, missing=c.capacity_min_mw))
        rules.append(ConflictingDuplicateRule(c.feeder, c.capacity_min_mw))
        negative_cols = [x for x in (c.capacity_min_mw, c.capacity_max_mw) if x]
        rules.append(NegativeCapacityRule(negative_cols))
    if c.capacity_min_mw and c.capacity_max_mw:
        rules.append(MinAboveMaxRule(c.capacity_min_mw, c.capacity_max_mw))
    if c.analysis_date and c.der_added_since_analysis_mw:
        rules.append(StaleAnalysisRule(c.analysis_date, c.der_added_since_analysis_mw, reference_date))
    return rules
