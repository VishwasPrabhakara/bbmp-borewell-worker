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
```

## Required Worker Secrets

Set these using Wrangler:

```powershell
npx wrangler secret put DATABASE_URL
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GH_OWNER
npx wrangler secret put GH_REPO
npx wrangler secret put GH_BRANCH
```

Expected values:

```text
DATABASE_URL=<Neon PostgreSQL connection string>
GITHUB_TOKEN=<GitHub fine-grained token with Actions workflow dispatch access>
GH_OWNER=VishwasPrabhakara
GH_REPO=bbmp-borewell-backend
GH_BRANCH=main
```

## Local Development

```powershell
npm install
npx wrangler dev
```

## Deploy

```powershell
npx wrangler deploy
```

## Security Notes

Do not commit `.dev.vars`, `.env`, database URLs, GitHub tokens, or KH credentials.


