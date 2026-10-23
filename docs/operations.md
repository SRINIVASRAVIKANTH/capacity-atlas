# Operations

## Weekly run

`.github/workflows/weekly-snapshot.yml` runs every Monday at 10:00 UTC and can be started by
hand from the Actions tab (Weekly snapshot, Run workflow). It takes about 15 minutes.

What to check after a run:

* The run is green in the Actions tab.
* `reports/LATEST.md` has the new date and every source shows `OK`.
* A release named `snapshot-YYYY-MM-DD` holds one parquet file per source.
* The site's panel shows the new "Data as of" date.
* `reports/history/feeder_capacity.json` lists the new date (the run commits it with the reports).

The feeder capacity history rebuilds itself: if the file is deleted or damaged, the next run
starts it again from every snapshot in the releases.

If a utility's server is down, that source shows `FAILED` in `LATEST.md`, the others still
publish, and the map keeps that utility's previous snapshot. The same happens when a server
answers with an empty layer or with fewer than half the line sections of the last good
snapshot: the download is treated as broken and not published.

## Secrets

| Where | Name | Used for |
|---|---|---|
| GitHub, repository secrets | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Uploading map data to Cloudflare R2 |
| Cloudflare Pages, project settings, Variables and Secrets (Secret, Production) | `ANTHROPIC_API_KEY` | The assistant at `/api/ask` |
| Cloudflare Pages (optional, plain variable) | `ANTHROPIC_MODEL` | Overrides the model, default `claude-haiku-5-5` |

Keys never go in the repository, in `web/`, or in chat messages and screenshots.

To replace a key: create the new key, save it in the secret store, start a deployment (any
push), confirm the feature works, then delete the old key.

## Costs

| Service | Plan | Cost |
|---|---|---|
| GitHub Actions and Releases | Public repository | Free |
| Cloudflare Pages and Functions | Free plan | Free |
| Cloudflare R2 | Standard storage, under the free tier | Free (budget alert set at $1) |
| OpenFreeMap basemaps, Photon search | Public services | Free, fair use |
| Claude API | Prepaid credit, auto reload off | A small fraction of a cent per question |

## Adding a utility

1. Find the utility's hosting capacity layer URL (an ArcGIS `FeatureServer/<n>` or
   `MapServer/<n>`).
2. Add a `Source` in `capacity_atlas/sources.py` with a `ColumnMap` for its column names.
3. Test the server: `python scripts/diagnose_arcgis.py --source <id>` requests 5, 100 and a
   full batch, and reports what fails.
4. Run `python -m capacity_atlas.pipeline --source <id>` locally, then
   `python scripts/inspect_snapshot.py` on the result.
5. Add the utility to `web/terms.html`: a card under "Data sources", and a note under
   "Disclaimers" (`<article class="notice" id="source-<id>">`) with its disclaimer or notice
   word for word in a `<blockquote class="disclaimer">`. Every card for that utility links to
   the note, and a test fails until it is there.
6. Read the utility's terms of use before publishing anything: some ask for a form, a
   disclaimer or written consent (see "Data use terms" below).
7. Add a test with a few rows shaped like the new source, then push.

Utilities checked and not used (with the reason) are listed in the docstring of
`capacity_atlas/sources.py`.

## Data use terms

### Utilities on the map

| Utility | What its terms ask | Status |
| --- | --- | --- |
| National Grid NY | The REST API Access Form; its disclaimer on any map showing the layers; a list of map users on request. Its portal terms also ask for written consent before its content is displayed for other purposes or its portal is linked to. | Disclaimer shown word for word on the terms page, linked from the map's credits and every National Grid card. No links to its portal. Asked National Grid on 2026-10-21 whether a public map with no sign-in, the downloads and the GitHub snapshot archive are acceptable. Form not submitted until they reply, since we cannot keep a user list. |
| Central Hudson | Its Solar PV Hosting Capacity Map page invites use of the service "within your own maps" and notes the data is for information only, not a substitute for the interconnection application process. Its website has no terms of use page, only a copyright line. Checked 2026-10-21. | Notice shown word for word on the terms page, linked from every Central Hudson card. The page links to the same service we read (`Hosting_Capacity_Stage3`, layer 0); only the name says Stage 3, and the values follow its October 1 and April 1 refreshes. |

### Utilities not on the map yet

Checked on 2026-10-21 and 2026-10-22, before writing any code for them. None allows its data on
another public website without asking, so each needs written permission first.

| Utility (states) | How it publishes | What its terms say | Status |
| --- | --- | --- | --- |
| Con Edison and Orange & Rockland (NY, NJ) | Public ArcGIS REST services, no key (`services.arcgis.com/ciPnsNFi1JLWVjva`), in the same Joint Utilities format as Central Hudson and National Grid | The hosting capacity page says the data is for information only. The website's General Terms of Service ask for express prior written consent to reproduce, distribute or systematically download content. | Permission requested from DGExpert@conEd.com on 2026-10-22. Not added until they reply. |
| Pepco, Delmarva Power, Atlantic City Electric (DC, MD, DE, NJ) | Public map on Exelon's shared ArcGIS site | No terms of use found for the map data; the map carries a disclaimer that its accuracy is not guaranteed. | Permission requested from the Green Power Connection team, gpc-south@pepco.com, on 2026-10-22. Not added until they reply. |
| NY Integrated Energy Data Resource (IEDR) | One platform for every New York utility | Personal or internal business use only; the data may not be reproduced or distributed, and robots are not allowed. | Not usable for a public map. |
| Ameren Illinois (IL) | Public map; not offered for Missouri | Materials may not be reproduced, published or redistributed, and use on any other website is prohibited. | Only with written permission (renewablesillinois@ameren.com). |
| Dominion Energy (VA, NC) | Public maps with REST services | Use of site material on any other website is prohibited, and public or commercial use is not allowed. | Only with written permission. |
| National Grid (MA, RI) | Public REST services | Written consent needed to display its content or link to its portal. | Not requested. |
| Eversource (MA, NH, CT) | Developer portal; its server rejects bulk requests | | Not usable. |
| PG&E, San Diego Gas & Electric, NV Energy, Georgia Power, PSEG Long Island | Behind accounts | Sign-up and their terms required | Not usable. |
| Xcel Energy (MN, CO) | Public map | Not checked yet | Open. |

If a utility has not replied after about two weeks, send one short follow-up. When one agrees,
keep its reply with the project records, add its terms to the table above, and add its
disclaimer to `web/terms.html` before its data goes live.

## Running locally

```
conda create -n capacity-atlas python=3.12 -y
conda activate capacity-atlas
pip install -r requirements.txt
pytest -q
python -m capacity_atlas.pipeline --all
```

To lint the web code as the Tests workflow does: `npm ci`, then `npm run lint` and `npm test`.

Building tiles needs tippecanoe, which runs on Linux and macOS (the weekly run installs it).
To preview the site, serve `web/` with any static server; the map reads data from the R2 URL
in `web/config.js`. The assistant only works when deployed, because it needs the secret key.

## Known limits

* `pub-....r2.dev` is Cloudflare's development URL and is rate limited. A custom domain on the
  bucket is the production setup: change `dataUrl` in `web/config.js` and add the new domain to
  `connect-src` in `web/_headers` (a test fails until both agree).
* The R2 bucket's CORS policy allows only `https://capacity-atlas.pages.dev`. A new site
  address, or previewing `web/` locally against the live data, needs that origin added in
  the bucket's settings (R2, the bucket, Settings, CORS Policy).
* Photon and OpenFreeMap are free public services without a service level agreement.
* The assistant's rate limit is kept in memory per Cloudflare instance, so it is best effort.
  Prepaid credit is the hard spending cap.
