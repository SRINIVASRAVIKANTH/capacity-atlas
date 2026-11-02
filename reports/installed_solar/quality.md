# Data quality report: solar already built (NYSERDA)

Source: [Statewide Distributed Solar Projects: Beginning 2000](https://data.ny.gov/d/wgsj-jt5f)  
Data through: 2026-08-31  
Rows checked: 280,745 (280,944 systems, 6,342.3 MW)

| Severity | Check | Flagged rows | % of rows | kW on flagged rows | Example project IDs |
|---|---|---:|---:|---:|---|
| ERROR | No system size | 1 | 0.0 | 0.0 | 3/2/3644 |
| ERROR | Connected after the data-through date | 0 | 0.0 | 0.0 | none |
| WARNING | ZIP code is not five digits | 2 | 0.0 | 12.0 | 8/21/2515, 8/10/2120 |
| WARNING | County is not a New York county | 1 | 0.0 | 6.0 | 8/21/2515 |
| WARNING | No connection date | 0 | 0.0 | 0.0 | none |
| WARNING | ZIP code is outside New York | 0 | 0.0 | 0.0 | none |
| INFO | No metering method | 508 | 0.18 | 167,725.0 | SDG-88655, SDG-82968, SDG-71897, SDG-71575, SDG-65576 |
| INFO | No circuit ID | 301 | 0.11 | 104,267.4 | PAM-2026-399176, PAM-2026-398970, PAM-2026-398368, PAM-2026-397725, PAM-2026-397562 |
| INFO | No Census ZIP area for this ZIP code | 270 | 0.1 | 27,131.5 | SDG-93635, SDG-92323, SDG-85367, SDG-78786, SDG-64662 |
| INFO | Project ID used more than once | 74 | 0.03 | 21,697.7 | LDG-00304, LDG-00304, LDG-00294, LDG-00294, LDG-00292 |

## Matching to feeders on the capacity map

| Utility | Feeders with a published capacity | With solar on record | Solar on those feeders | All of the utility's solar |
|---|---:|---:|---:|---:|
| Central Hudson | 230 | 225 | 374.7 MW | 396.6 MW |
| National Grid | 1,913 | 1,605 | 2,109.8 MW | 2,425.0 MW |

Not placed on the map (no usable ZIP code): 273 systems, 27.1 MW. They are still in the state totals.

Flags mean 'worth checking', not proof of an error. Rows are counted as published.
