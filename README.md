<div align="center">

<img src="docs/images/banner.svg" alt="Capacity Atlas: where New York's power lines have room for new solar" width="100%">

### Where the grid has room for solar, and where solar is already built, updated every Monday

[![Live map](https://img.shields.io/badge/Live_map-capacity--atlas.pages.dev-6E76F0?style=flat&logo=cloudflare&logoColor=white)](https://capacity-atlas.pages.dev)
[![Tests](https://github.com/SRINIVASRAVIKANTH/capacity-atlas/actions/workflows/tests.yml/badge.svg)](https://github.com/SRINIVASRAVIKANTH/capacity-atlas/actions/workflows/tests.yml)
[![Weekly snapshot](https://github.com/SRINIVASRAVIKANTH/capacity-atlas/actions/workflows/weekly-snapshot.yml/badge.svg)](https://github.com/SRINIVASRAVIKANTH/capacity-atlas/actions/workflows/weekly-snapshot.yml)
<br>
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?style=flat&logo=python&logoColor=white)](https://www.python.org)
[![MapLibre](https://img.shields.io/badge/MapLibre_GL-5.24-396CB2?style=flat&logo=maplibre&logoColor=white)](https://maplibre.org)
[![Claude API](https://img.shields.io/badge/Claude_API-tool_use-D97757?style=flat&logo=anthropic&logoColor=white)](https://docs.claude.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**[🗺️ Open the live map](https://capacity-atlas.pages.dev)** &nbsp;·&nbsp; [📊 This week's report](reports/LATEST.md) &nbsp;·&nbsp; [🏗️ Architecture](docs/architecture.md)

</div>

---

## 🌞 What is Capacity Atlas?

A new solar farm has to plug into a nearby power line. Some lines have room for more power,
and many are already full. Plugging into a full line can mean paying for upgrades that cost
more than the whole project.

Utilities in New York publish maps that show how much new solar each line can take. This is
called **hosting capacity**, measured in megawatts (MW). But every utility publishes its own
map in its own format, nobody keeps track of how the numbers change, and nobody checks them
for mistakes.

**Capacity Atlas fixes that.** Every Monday it:

1. 📥 **Collects** the hosting capacity data from Central Hudson and National Grid
2. ✅ **Checks** every record with 14 data quality rules
3. 🔄 **Compares** this week with last week and shows what changed on the map
4. 🗺️ **Publishes** both utilities on one free, public map
5. 🌞 **Adds the solar already built**: New York's statewide list of connected projects, by ZIP
   code on its own page and on every feeder's card

**Who it is for:** solar developers choosing land, landowners leasing it, and planners
looking for where the grid needs upgrades. Instead of opening two utility maps and
guessing, they see every line on one color scale, know which numbers look wrong, and can
simply ask the map a question in plain English.

<p align="center">
  <img src="docs/images/demo.gif" alt="Asking Volta where near Albany 2 MW can connect, and the map flying to Albany and filtering itself" width="900">
  <br><b>Figure 1.</b> Ask Volta a question in plain English. The map flies to Albany, keeps only lines with room for 2 MW, and counts them from the data.
</p>

<p align="center">
  <img src="docs/images/overview.png" alt="Capacity Atlas showing hosting capacity across upstate New York and the Hudson Valley" width="900">
  <br><b>Figure 2.</b> 758,915 line sections from two utilities on one map. Yellow lines have the most room, purple the least.
</p>

---

## 🔍 What it found

| | Central Hudson | National Grid |
|---|---:|---:|
| ⚡ Line sections | 306,419 | 452,496 |
| 📈 Capacity published | 54% | 100% |
| ❌ Contradictory values | 0 | 0 |
| ⏳ Analysis older than 6 months, with new solar connected since | 30,143 sections, 31 feeders | |
| ❓ Feeder listed but substation missing | 8,716 sections, 22 feeders | |
| 🔒 Total capacity below every published limit | | 28,875 sections, 906 feeders |

Snapshot of October 9, 2026. The current week is in [`reports/LATEST.md`](reports/LATEST.md),
and every check is explained in [docs/data-quality.md](docs/data-quality.md).

<p align="center">
  <img src="docs/images/quality.png" alt="Data quality highlight around Poughkeepsie, with the most flagged feeders listed" width="900">
  <br><b>Figure 3.</b> Data quality highlight around Poughkeepsie. Lines with issues stay in color, the rest turn gray, and the panel lists the feeders with the most problems.
</p>

On October 26, National Grid's data changed for the first time since tracking began. 2,063
line sections lost capacity and 562 gained, and 1,366 were added and 1,520 removed where the
utility redrew parts of its network. No feeder's analysis date changed, so these new values
show up only by comparing one week with the next. The full list is in
[`reports/national_grid_ny_pv/changes/`](reports/national_grid_ny_pv/changes/).

<p align="center">
  <img src="docs/images/changes.png" alt="Changed lines east of Troy, with a National Grid feeder whose highest capacity fell from 8.8 MW to 0 MW on October 26" width="900">
  <br><b>Figure 4.</b> The week of October 26, east of Troy. Orange lines lost capacity since the week before. This feeder's best spot fell from 8.8 MW to 0 MW, and its history chart shows the drop.
</p>

New York has 6,342 MW of distributed solar already connected, in 280,944 systems, from
NYSERDA's statewide list (data through August 31, 2026). 774 MW of it was connected in the
last 12 months. Community solar is only 0.6% of the systems but 45% of the capacity. Matched
by exact circuit ID, 225 of the 230 Central Hudson feeders and 1,605 of the 1,913 National Grid
feeders with a published capacity have solar on record. The list's own checks are in
[`reports/installed_solar/quality.md`](reports/installed_solar/quality.md).

<p align="center">
  <img src="docs/images/built-so-far.png" alt="Built so far: one circle per ZIP code across New York, sized by the solar already connected, with the state totals in the panel" width="900">
  <br><b>Figure 5.</b> Built so far. One circle per ZIP code, sized by the solar already connected, with an inner circle for what was connected in the last 12 months. Long Island, the Hudson Valley and the Capital Region stand out.
</p>

<p align="center">
  <img src="docs/images/built-zip-card.png" alt="ZIP code 12603 in Poughkeepsie selected: 16 MW from 1,448 systems, main utility Central Hudson" width="900">
  <br><b>Figure 6.</b> ZIP code 12603 in Poughkeepsie: 16 MW from 1,448 systems, 1.5 MW of it in the last 12 months. "See room to connect here" opens the capacity map at the same place.
</p>

---

## ✨ Features

| | Feature | What it does |
|---|---|---|
| 🗺️ | **One map, two utilities** | 758,915 line sections on one color scale, filtered by minimum capacity and by utility |
| 📍 | **Site check** | Enter a project size and pick a spot or search an address. The map finds the nearest line with enough room, draws the link and gives the distance |
| 🔗 | **Share and download** | Copy a link that reopens a site check or a ZIP code's card for a colleague, or save what is in view as a CSV spreadsheet or a GeoJSON map file: the lines, with the filters applied, or the ZIP codes with their solar totals |
| 🔎 | **Two levels of detail** | Zoomed out, a click selects a whole feeder and shows its capacity range. Zoomed in, a click shows one section's value, length, voltage, phases, analysis date and data issues, and the solar already connected on its feeder |
| 🌞 | **Built so far** | A second view of the same map: the solar already connected in each ZIP code, with an inner circle for what was connected in the last 12 months, state totals, a year by year chart, the list's own data checks and a short guide. A switch at the top of the panel moves between the two views and keeps the place |
| ▶️ | **Growth year by year** | Press play and every ZIP code's circle grows from the first year on record to today, with the statewide total counting up and the year chart marking the year shown. Pause or drag the slider to stop at any year |
| 🧭 | **What limits each line** | For National Grid, the card names the criterion that caps the line (voltage rise, overload, flicker and others) in plain words, worked out from the separate values the utility publishes, and says so when the cap is something the utility does not publish |
| ✅ | **Weekly validation** | 14 checks, from impossible values to analyses that new solar has made outdated |
| 🔄 | **Changes since last week** | Each week is compared with the one before, section by section. Lines that gained or lost capacity, or are new, can be highlighted on the map |
| 📈 | **Capacity history** | Each feeder's highest capacity is tracked week by week. The feeder card draws the trend, and a line's card says whether its feeder is filling up |
| 🕰️ | **Snapshot archive** | Every weekly snapshot is kept as GeoParquet in the repository's releases, with a report of what changed |
| 🤖 | **Volta, the assistant** | Ask "Where near Albany can I connect 2 MW?" or "How far is the nearest line for 3 MW from Troy?" and the map moves, filters and measures itself. Follow-ups like "and for 5 MW?" keep the place, "hide that" or "back to normal" undo, spelling mistakes are understood, and an unclear question gets a question back. On Built so far, ask "Which ZIP codes near Albany have the most solar?" or "How much solar was there in 2015?" and it ranks, opens cards or shows that year. On both pages the side panel opens at the section an answer is about |
| 📜 | **Data sources and terms** | One page, linked from the map's credits, its panel and every card, credits each source, shows each source's disclaimer in its own words, and sets out the site's terms of use, privacy, copyright and security |
| ♿ | **Built for everyone** | Light and dark themes, a color blind safe scale, severity shown by shape as well as color, keyboard support, a phone layout, and no motion for people who turn it off in their system settings |

<p align="center">
  <img src="docs/images/detail.png" alt="A selected National Grid section with its feeder outlined, and the card naming voltage rise and overload as what limits the line" width="900">
  <br><b>Figure 7.</b> One selected section. Its whole feeder is outlined, and the card shows the published values, what limits the line and any data issues.
</p>

<p align="center">
  <img src="docs/images/solar-on-feeder.png" alt="A Central Hudson section near Poughkeepsie whose card shows 0.31 MW of solar already connected on its feeder, from 42 systems" width="900">
  <br><b>Figure 8.</b> The two views meet on the card. This section's feeder already has 0.31 MW of solar from 42 systems, matched by the feeder ID in NYSERDA's list.
</p>

<p align="center">
  <img src="docs/images/site-check.png" alt="Site check from the panel: a 3 MW project in Saratoga Springs is 0.1 miles from a line with room for it" width="900">
  <br><b>Figure 9.</b> Site check from the panel. A 3 MW project in Saratoga Springs is 0.1 mi from a line that can take it, shown by the dashed link.
</p>

<p align="center">
  <img src="docs/images/assistant.png" alt="Volta answering Where near Albany can I connect 2 MW by filtering and moving the map" width="900">
  <br><b>Figure 10.</b> Volta turns a question into map settings. Every number in the answer is counted from the data on screen, not written by the AI.
</p>

<p align="center">
  <img src="docs/images/site-check-volta.png" alt="Volta answering Nearest line for 3 MW from Kingston with the distance and the line on the map" width="900">
  <br><b>Figure 11.</b> Volta runs the same site check from a plain question. The nearest line with room for 3 MW is 0.2 mi from Kingston, on a Central Hudson feeder.
</p>

<p align="center">
  <img src="docs/images/dark-mobile.png" alt="Capacity Atlas in the dark theme on a phone" width="300">
  <br><b>Figure 12.</b> Dark theme on a phone.
</p>

---

## ⚙️ How it works

```mermaid
flowchart LR
    U[Utility ArcGIS services] --> P[Weekly pipeline<br>GitHub Actions]
    N[NYSERDA solar list<br>and Census ZIP areas] --> P
    P --> R[(Reports in the repo)]
    P --> H[(Snapshot history<br>GitHub Releases)]
    P --> T[(Vector tiles<br>Cloudflare R2)]
    T --> M[Web map<br>Cloudflare Pages]
    M <--> V[Volta<br>Pages Function]
    V <--> C[Claude API]
```

Every Monday a GitHub Actions run downloads each utility's full layer, saves a snapshot,
runs the checks, compares with the previous week, adds the week to each feeder's capacity
history, builds one PMTiles file and uploads it to Cloudflare R2. It also reads NYSERDA's list
of connected solar from data.ny.gov, checks it, totals it by ZIP code and by feeder, and
uploads those small files too. The site is static HTML, CSS and JavaScript on Cloudflare
Pages, and it reads only the map tiles in view, straight from R2. Details are in
[docs/architecture.md](docs/architecture.md).

---

## 🧠 Design decisions

* 🎯 **The AI never states numbers.** Claude is called with one forced tool that returns a
  place, a minimum size, a utility, whether to run the site check and a short sentence. The
  browser computes every count and distance from the data, so answers stay grounded and each
  question costs a fraction of a cent.
* 🧩 **Each utility's schema is mapped, not assumed.** A `ColumnMap` per source translates
  different column names into one vocabulary, so checks and the map work the same way for
  every utility. Adding a utility is one entry plus a test.
* 🛡️ **A failure in one utility never blocks the others.** Each source runs on its own, and
  the map keeps the last good snapshot of any utility that fails. A download that comes back
  empty, or with under half of last week's lines, is treated as a failure, so a server glitch
  never wipes a utility off the map.
* 🧱 **Built to extend.** Collectors and quality checks are abstract base classes. A utility on
  another platform gets its own `Collector` subclass, and a new check is one `QualityRule`
  subclass; the pipeline, reports and map pick them up unchanged.
* 🌞 **Room left and solar built never share a map.** They answer different questions, so each
  has its own view, and a switch keeps the place between them. ZIP codes are drawn as circles
  sized by MW, not shaded areas, because a large rural ZIP code would otherwise look like it
  holds the most solar just for being big. A project is linked to a feeder only when its
  circuit ID is exactly the feeder's ID.
* 💸 **Free to run.** GitHub, Cloudflare Pages and R2 free tiers, free basemaps and search.
  The only cost is the assistant, capped by prepaid credit.
* 🔐 **Secure by default.** The Claude key is an encrypted Cloudflare secret. The function
  accepts only the site's own origin, caps question and body size, times out slow calls and
  rate limits each visitor. The site sends a strict Content Security Policy, and every value
  from the utilities or the AI is shown as text, never as HTML. Details in
  [SECURITY.md](SECURITY.md).

---

## 🛠️ Tech stack

| Area | Tools |
|---|---|
| 📥 Data collection and processing | Python 3.12, Requests, GeoPandas, Shapely, PyArrow, GeoParquet, Socrata SODA API, Census TIGERweb |
| ✅ Validation and history | Rule classes in Python, snapshot comparison by section ID |
| 🔁 Automation | GitHub Actions (weekly run and tests), GitHub Releases |
| 🧱 Map data | tippecanoe, PMTiles, Cloudflare R2 |
| 🗺️ Web map | MapLibre GL JS, PMTiles, OpenFreeMap, Photon, plain HTML, CSS and JavaScript |
| 🤖 Assistant | Cloudflare Pages Functions, Claude API (Haiku) with tool use |
| 🧪 Testing and quality | pytest (122 tests, 90% coverage), Node test runner (57 tests) for the assistant function and the browser helpers, Ruff and ESLint, all run on every push |

---

## 📁 Repository

```
capacity_atlas/       Python package: collectors, sources, quality checks, changes, tiles, pipeline
functions/api/ask.js  The assistant's server function
web/                  The website, deployed as is: the capacity map, the Built so far page and the data sources and terms page
reports/              Weekly quality and change reports, the feeder capacity history and the solar list's checks, written by the pipeline
tests/                Python and JavaScript tests
docs/                 Architecture, data quality and operations
scripts/              Diagnostic tools used while adding a utility
SECURITY.md           How the project is protected and how to report a problem
```

---

## 🚀 Run it locally

```
conda create -n capacity-atlas python=3.12 -y
conda activate capacity-atlas
pip install -r requirements.txt
pytest -q
python -m capacity_atlas.pipeline --all
python -m capacity_atlas.installed
```

Secrets, costs, adding a utility and known limits are covered in
[docs/operations.md](docs/operations.md).

---

## 📋 Data and limits

Hosting capacity values are estimates published by each utility for early screening. They
do not replace a utility interconnection study. Data sources: Central Hudson Gas & Electric
and National Grid public hosting capacity services; solar already built from NYSERDA's
Statewide Distributed Solar Projects on data.ny.gov (OPEN-NY Terms of Use), placed with US
Census Bureau ZIP Code Tabulation Areas. Basemap by OpenFreeMap with OpenMapTiles and
OpenStreetMap data; place search by Photon. Each utility's disclaimer, in its own words,
and the site's terms of use and privacy are on the
[Data sources and terms](https://capacity-atlas.pages.dev/terms) page.

## 📄 License

Code under the [MIT License](LICENSE). The data belongs to the utilities and agencies that
publish it.

---

<div align="center">

Built by **[Srinivas Ravikanth](https://github.com/SRINIVASRAVIKANTH)** 🌞

</div>
