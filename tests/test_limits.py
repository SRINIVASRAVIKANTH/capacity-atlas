"""Which published criterion limits each section: the lowest one, when it sets the total."""

import pandas as pd
import pytest

from capacity_atlas.limits import LIMIT_BIT, LIMIT_KINDS, limit_legend, limiting_factors
from capacity_atlas.schema import ColumnMap
from capacity_atlas.sources import SOURCES

COLS = ("v", "t", "f")
KINDS = ("over_voltage", "thermal", "flicker")


def run(rows, ceiling=10.0):
    frame = pd.DataFrame(rows, columns=["hc", *COLS])
    return list(limiting_factors(frame, "hc", COLS, KINDS, ceiling))


def test_the_lowest_criterion_is_the_limit():
    assert run([[0.4, 0.4, 2.0, 3.0], [1.5, 6.0, 1.5, 3.0]]) == [LIMIT_BIT["over_voltage"], LIMIT_BIT["thermal"]]


def test_criteria_tied_at_the_lowest_value_are_all_reported():
    (mask,) = run([[0.0, 0.0, 0.0, 4.0]])
    assert mask == LIMIT_BIT["over_voltage"] | LIMIT_BIT["thermal"]


def test_no_answer_when_the_total_is_below_every_criterion_or_at_the_ceiling():
    # below every limit: something unpublished sets it (a quality check reports that)
    # at the 10 MW ceiling: "at least 10", not a limit
    assert run([[0.5, 2.0, 3.0, 4.0], [10.0, 10.0, 10.0, 25.0]]) == [pd.NA, pd.NA]


def test_missing_values_are_skipped_and_rounding_is_tolerated():
    assert run([[1.0, None, 1.004, 2.0], [None, 1.0, 2.0, 3.0]]) == [LIMIT_BIT["thermal"], pd.NA]


def test_bad_configuration_fails_loudly():
    frame = pd.DataFrame({"hc": [1.0], "v": [1.0]})
    with pytest.raises(ValueError, match="Unknown limit kind"):
        limiting_factors(frame, "hc", ("v",), ("magic",))
    with pytest.raises(ValueError, match="exactly one limit kind"):
        limiting_factors(frame, "hc", ("v", "t"), ("thermal",))
    with pytest.raises(ValueError, match="one kind for each"):
        ColumnMap(record_id="id", feeder="f", limit_columns=("a", "b"), limit_kinds=("thermal",))


def test_columns_missing_from_a_download_give_no_answer_not_an_error():
    frame = pd.DataFrame({"hc": [1.0]})
    assert list(limiting_factors(frame, "hc", COLS, KINDS)) == [pd.NA]


def test_every_source_names_known_kinds_and_every_bit_is_unique():
    bits = [k.bit for k in LIMIT_KINDS]
    assert len(set(bits)) == len(bits) and all(b & (b - 1) == 0 for b in bits)
    for source in SOURCES.values():
        c = source.columns
        if c and c.limit_kinds:
            assert set(c.limit_kinds) <= set(LIMIT_BIT)
            assert len(c.limit_kinds) == len(c.limit_columns)
    assert all({"bit", "kind", "title", "explanation"} <= set(e) for e in limit_legend())
