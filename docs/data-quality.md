# Data quality checks

Every snapshot is tested against the checks below. A check only runs when the utility
publishes the columns it needs, so each utility gets the checks that apply to its data.

Levels:

* **Error**: values contradict each other, so at least one of them is wrong.
* **Warning**: values are missing or possibly out of date.
* **Info**: worth knowing, not an error.

| Check | Level | What it catches |
|---|---|---|
| Duplicate line sections report different capacity | Error | The same geometry published twice with different values |
| Capacity value is negative | Error | Impossible value |
| Minimum capacity is greater than maximum capacity | Error | Range published backwards |
| Total capacity is above one of its own published limits | Error | The total cannot exceed any limit it is built from |
| Map color does not match the capacity value | Error | People reading the official map would see the wrong band |
| Feeder listed but substation missing | Warning | Cannot tell which substation serves the line |
| Substation listed but feeder missing | Warning | Incomplete record |
| Feeder listed but phase missing | Warning | Phase determines which projects can connect |
| Feeder listed but capacity value missing | Warning | Line analyzed in part only |
| Same line section published more than once | Warning | Duplicated records |
| Analysis over 6 months old, with new solar connected since | Warning | New solar connected after the analysis may have used up the published capacity |
| Line section has no hosting capacity analysis | Info | Mapped but not analyzed |
| Published capacity is exactly 0 MW | Info | Full line, or a placeholder value |
| Total capacity is below every published limit | Info | An unpublished constraint is reducing the value |

Rules live in `capacity_atlas/quality/rules.py`. Each one is a small class with a title, a
level, a plain-English explanation and a `check()` method that returns one true or false per
line section. Floating point comparisons use a tolerance of 0.005 MW.

## Findings (snapshot of October 9, 2026)

| | Central Hudson | National Grid |
|---|---:|---:|
| Line sections | 306,419 | 452,496 |
| With a published capacity | 165,756 (54%) | 452,496 (100%) |
| Errors | 0 | 0 |
| Analysis older than 6 months with new DER since | 30,143 sections on 31 feeders | not published |
| Feeder listed but substation missing | 8,716 sections on 22 feeders | not published |
| Feeder listed but phase missing | 1,759 sections on 138 feeders | not published |
| Feeder listed but capacity value missing | 1,370 sections on 14 feeders | 0 |
| Same line section published more than once | 70 | 0 |
| Total capacity below every published limit | not published | 28,875 sections on 906 feeders |

Current results are in [`reports/LATEST.md`](../reports/LATEST.md), with one folder of
weekly reports per utility.

## Solar already built (NYSERDA's list)

The "Built so far" page and the "Solar connected" row in each line's card come from NYSERDA's
statewide list of connected distributed solar (`capacity_atlas/installed.py`). Every row of the
list is checked the same way, and the result is committed to
[`reports/installed_solar/quality.md`](../reports/installed_solar/quality.md) and shown in the
page's panel. Rows are counted as published; a flag never removes a row.

| Check | Level | What it catches |
|---|---|---|
| No system size | Error | No size, or a size of zero or less. The project counts as a system but adds nothing to the MW totals |
| Connected after the data-through date | Error | A connection date later than the date the list says it covers |
| No connection date | Warning | Missing from the by-year chart |
| ZIP code is not five digits | Warning | Cannot be placed on the map |
| ZIP code is outside New York | Warning | A valid ZIP code, but not one used in New York |
| County is not a New York county | Warning | Not one of the state's 62 counties |
| No circuit ID | Info | Cannot be matched to a line; still in the ZIP and state totals |
| No metering method | Info | Cannot tell community solar from a home or business system |
| Project ID used more than once | Info | The same ID on more than one row |
| No Census ZIP area for this ZIP code | Info | Often a ZIP code for post office boxes or one building; counted in the state totals, not drawn |

### Findings (data through August 31, 2026)

Checked on 280,745 rows (280,944 systems, 6,342 MW):

* 1 row has no size, 2 have a ZIP code that is not five digits, and 1 is listed in Bennington
  County, which is in Vermont.
* 508 rows have no metering method and 301 have no circuit ID.
* 77 rows share 38 project IDs. For example, LDG-00014 appears once for Con Edison and once for
  Orange & Rockland.
* About 0.1% of rows have a ZIP code with no Census ZIP area; they are in the state totals but
  not on the map.
* Matching by exact circuit ID: 225 of the 230 Central Hudson feeders and 1,605 of the 1,913
  National Grid feeders with a published capacity (October 26 snapshot) have solar on record.
