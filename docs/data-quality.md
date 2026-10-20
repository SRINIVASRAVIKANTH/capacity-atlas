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
