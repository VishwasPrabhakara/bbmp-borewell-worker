# BBMP Borewell Worker API

Cloudflare Worker API for the BBMP Borewell Dashboard. It serves public dashboard data from Neon PostgreSQL and triggers the backend GitHub Actions refresh workflow when dashboard data is stale.

## Live API

```text
https://bbmp-borewell-api.vishwas-borewellworkersdev.workers.dev
```

## Repository Role

This repo is the public API layer:

```text
GitHub Pages dashboard
  -> Cloudflare Worker API
  -> Neon PostgreSQL

Worker /api/refresh
  -> GitHub Actions workflow in bbmp-borewell-backend
```

## Files

```text
src/index.js
package.json
package-lock.json
wrangler.toml
.gitignore
README.md
```

## Routes

```text
GET /api/status
GET /api/refresh
GET /api/sensors
GET /api/water-level?uid=<sensor_uid>
GET /api/qc/sensors
GET /api/qc/sensors?ward_no=<ward_no>
GET /api/qc/sensors?status=<qc_status>
GET /api/qc/wards
GET /admin-upload
POST /api/admin/upload-type-a
POST /api/admin/upload-type-b
POST /api/admin/recalculate-summaries
```

## Required Worker Secrets

Set these using Wrangler:

```powershell
npx wrangler secret put DATABASE_URL
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GH_OWNER
npx wrangler secret put GH_REPO
npx wrangler secret put GH_BRANCH
npx wrangler secret put ADMIN_PASSWORD
```

Expected values:

```text
DATABASE_URL=<Neon PostgreSQL connection string>
GITHUB_TOKEN=<GitHub fine-grained token with Actions workflow dispatch access>
GH_OWNER=VishwasPrabhakara
GH_REPO=bbmp-borewell-backend
GH_BRANCH=main
ADMIN_PASSWORD=<password for hidden upload page>
```

## Hidden Admin Upload

The TypeA/TypeB zip upload page is available only at:

```text
https://bbmp-borewell-api.vishwas-borewellworkersdev.workers.dev/admin-upload
```

It is not linked from the public dashboard. Upload requests require the `ADMIN_PASSWORD` Worker secret.

Uploaded TypeA/TypeB data is stored in separate tables and takes priority for plotting. For a UID with uploaded rows, `/api/water-level` returns uploaded rows. For a UID without uploaded rows, it falls back to the KH website `water_levels` table.

## Local Development

```powershell
npm install
npx wrangler dev
```

For local development, create `.dev.vars` with local-only secret values:

```text
DATABASE_URL=<Neon PostgreSQL connection string>
GITHUB_TOKEN=dummy
GH_OWNER=VishwasPrabhakara
GH_REPO=bbmp-borewell-backend
GH_BRANCH=main
ADMIN_PASSWORD=dummy
```

Only `DATABASE_URL` is required to test read-only routes such as `/api/sensors`, `/api/water-level`, `/api/qc/sensors`, and `/api/qc/wards`.

## Deploy

```powershell
npx wrangler deploy
```

## Security Notes

Do not commit `.dev.vars`, `.env`, database URLs, GitHub tokens, or KH credentials.

## Sensor QC API

The QC routes read from backend-generated tables:

```text
sensor_qc_summary
ward_sensor_qc_summary
```

Run the backend QC job before using these routes:

```powershell
cd D:\bbmp-borewell-backend
python run_sensor_qc.py
```

Supported QC status values:

```text
GOOD
USABLE_WITH_CAUTION
POOR
INSUFFICIENT_DATA
NO_DATA
```
