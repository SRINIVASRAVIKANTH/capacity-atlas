# Operations

## Weekly run

`.github/workflows/weekly-snapshot.yml` runs every Monday at 10:00 UTC and can be started by
hand from the Actions tab (Weekly snapshot, Run workflow). It takes about 15 minutes.

What to check after a run:

* The run is green in the Actions tab.
* `reports/LATEST.md` has the new date and every source shows `OK`.
* A release named `snapshot-YYYY-MM-DD` holds one parquet file per source.
* The site's panel shows the new "Data as of" date.

If a utility's server is down, that source shows `FAILED` in `LATEST.md`, the others still
publish, and the map keeps that utility's previous snapshot.

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
5. Add a test with a few rows shaped like the new source, then push.

Utilities checked and not used (with the reason) are listed in the docstring of
`capacity_atlas/sources.py`.

## Running locally

```
conda create -n capacity-atlas python=3.12 -y
conda activate capacity-atlas
pip install -r requirements.txt
pytest -q
python -m capacity_atlas.pipeline --all
```

Building tiles needs tippecanoe, which runs on Linux and macOS (the weekly run installs it).
To preview the site, serve `web/` with any static server; the map reads data from the R2 URL
in `web/config.js`. The assistant only works when deployed, because it needs the secret key.

## Known limits

* `pub-....r2.dev` is Cloudflare's development URL and is rate limited. A custom domain on the
  bucket is the production setup (change `dataUrl` in `web/config.js`).
* Photon and OpenFreeMap are free public services without a service level agreement.
* The assistant's rate limit is kept in memory per Cloudflare instance, so it is best effort.
  Prepaid credit is the hard spending cap.
