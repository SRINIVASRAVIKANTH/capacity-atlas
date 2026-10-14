<div align="center">

<img src="docs/images/banner.svg" alt="Capacity Atlas: where New York's power lines have room for new solar" width="100%">

### One map for two utilities, 14 data checks, updated every Monday

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
3. 🔄 **Compares** this week with last week and reports what changed
4. 🗺️ **Publishes** both utilities on one free, public map

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

---

## ✨ Features

| | Feature | What it does |
|---|---|---|
| 🗺️ | **One map, two utilities** | 758,915 line sections on one color scale, filtered by minimum capacity and by utility |
| 🔎 | **Two levels of detail** | Zoomed out, a click selects a whole feeder and shows its capacity range. Zoomed in, a click shows one section's value, length, voltage, phases, analysis date and data issues |
| ✅ | **Weekly validation** | 14 checks, from impossible values to analyses that new solar has made outdated |
| 🕰️ | **History** | Every weekly snapshot is kept as GeoParquet in the repository's releases, with a report of what changed |
| 🤖 | **Volta, the assistant** | Ask "Where near Albany can I connect 2 MW?" and the map moves and filters itself |
| ♿ | **Built for everyone** | Light and dark themes, a color blind safe scale, severity shown by shape as well as color, keyboard support and a phone layout |

<p align="center">
  <img src="docs/images/detail.png" alt="A selected section with its feeder highlighted and the details card" width="900">
  <br><b>Figure 4.</b> One selected section. Its whole feeder is outlined, and the card shows the published values and any data issues.
</p>

<p align="center">
  <img src="docs/images/assistant.png" alt="Volta answering Where near Albany can I connect 2 MW by filtering and moving the map" width="900">
  <br><b>Figure 5.</b> Volta turns a question into map settings. Every number in the answer is counted from the data on screen, not written by the AI.
</p>

<p align="center">
  <img src="docs/images/dark-mobile.png" alt="Capacity Atlas in the dark theme on a phone" width="300">
  <br><b>Figure 6.</b> Dark theme on a phone.
</p>

---

## ⚙️ How it works

```mermaid
flowchart LR
    U[Utility ArcGIS services] --> P[Weekly pipeline<br>GitHub Actions]
    P --> R[(Reports in the repo)]
    P --> H[(Snapshot history<br>GitHub Releases)]
    P --> T[(Vector tiles<br>Cloudflare R2)]
    T --> M[Web map<br>Cloudflare Pages]
    M <--> V[Volta<br>Pages Function]
    V <--> C[Claude API]
```

Every Monday a GitHub Actions run downloads each utility's full layer, saves a snapshot,
runs the checks, compares with the previous week, builds one PMTiles file and uploads it to
Cloudflare R2. The site is static HTML, CSS and JavaScript on Cloudflare Pages, and it reads
only the map tiles in view, straight from R2. Details are in
[docs/architecture.md](docs/architecture.md).

---

## 🧠 Design decisions

* 🎯 **The AI never states numbers.** Claude is called with one forced tool that returns a
  place, a minimum size, a utility and a short sentence. The browser computes every count
  from the data, so answers stay grounded and each question costs a fraction of a cent.
* 🧩 **Each utility's schema is mapped, not assumed.** A `ColumnMap` per source translates
  different column names into one vocabulary, so checks and the map work the same way for
  every utility. Adding a utility is one entry plus a test.
* 🛡️ **A failure in one utility never blocks the others.** Each source runs on its own, and
  the map keeps the last good snapshot of any utility that fails.
* 💸 **Free to run.** GitHub, Cloudflare Pages and R2 free tiers, free basemaps and search.
  The only cost is the assistant, capped by prepaid credit.
* 🔐 **Secrets stay server side.** The Claude key is an encrypted Cloudflare secret. The
  function accepts only the site's own origin, limits question length and rate limits each
  visitor.

---

## 🛠️ Tech stack

| Area | Tools |
|---|---|
| 📥 Data collection and processing | Python 3.12, Requests, GeoPandas, Shapely, PyArrow, GeoParquet |
| ✅ Validation and history | Rule classes in Python, snapshot comparison by section ID |
| 🔁 Automation | GitHub Actions (weekly run and tests), GitHub Releases |
| 🧱 Map data | tippecanoe, PMTiles, Cloudflare R2 |
| 🗺️ Web map | MapLibre GL JS, PMTiles, OpenFreeMap, Photon, plain HTML, CSS and JavaScript |
| 🤖 Assistant | Cloudflare Pages Functions, Claude API (Haiku) with tool use |
| 🧪 Testing | pytest (56 tests), Node test runner, Playwright for visual checks |

---

## 📁 Repository

```
capacity_atlas/       Python package: collectors, sources, quality checks, changes, tiles, pipeline
functions/api/ask.js  The assistant's server function
web/                  The website, deployed as is
reports/              Weekly quality and change reports, written by the pipeline
tests/                Python and JavaScript tests
docs/                 Architecture, data quality and operations
scripts/              Diagnostic tools used while adding a utility
```

---

## 🚀 Run it locally

```
conda create -n capacity-atlas python=3.12 -y
conda activate capacity-atlas
pip install -r requirements.txt
pytest -q
python -m capacity_atlas.pipeline --all
```

Secrets, costs, adding a utility and known limits are covered in
[docs/operations.md](docs/operations.md).

---

## 📋 Data and limits

Hosting capacity values are estimates published by each utility for early screening. They
do not replace a utility interconnection study. Data sources: Central Hudson Gas & Electric
and National Grid public hosting capacity services. Basemap by OpenFreeMap with
OpenMapTiles and OpenStreetMap data; place search by Photon.

## 📄 License

Code under the [MIT License](LICENSE). The data belongs to the utilities that publish it.

---

<div align="center">

Built by **[Srinivas Ravikanth](https://github.com/SRINIVASRAVIKANTH)** 🌞

</div>
