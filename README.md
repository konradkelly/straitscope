# Strait Tracker

Real-time Strait of Hormuz vessel traffic monitor with route-split classification
(northern "Route of Authority" vs. southern Omani corridor).

**Read `spec.md` first** — it's the authoritative design doc.

## Quick start

```bash
cp .env.example .env      # add your free aisstream.io API key + a db password
docker compose up -d      # db + ingest + worker + api
docker compose logs -f ingest
```

Positions start landing in `vessel_positions` within seconds. The worker
detects completed transits every 5 minutes. The API is served at
`http://localhost:8080` (see `spec.md` §7 for endpoints).

## Local development

```bash
cp .env.example .env      # fill in AISSTREAM_API_KEY, DB_PASSWORD, DATABASE_URL
npm install
npm run dev                # starts the db in Docker, runs ingest+worker+api on the host

cd web && npm install && npm run dev   # frontend, separate terminal
```

`npm run dev` starts only the `db` container (via `docker compose up -d --wait
db`, published on `localhost:5434` since 5432 is often taken by a local
Postgres install) and runs `src/ingest.js`, `src/worker.js`, and `src/api.js`
directly with `node --watch`, restarting on save. Faster than rebuilding
Docker images for every change.

The frontend (`web/`) is a separate Vite project. Its dev server
(`http://localhost:5173`) proxies `/api/*` and `/healthz` to the API on
`:8080`, so both need to be running locally. `npm run build` inside `web/`
produces a static `web/dist/` deployable behind any static host.

## Run tests

```bash
npm ci
npm test
```

## Before launch (do not skip)

1. **Calibrate geometry** — the gate lines and corridor polygons in
   `src/geo.js` are placeholders. Collect a few days of positions, plot the
   tracks, and trace the real lanes. Spec §6 explains why this matters.
2. Add the not-for-navigation disclaimer to the frontend (spec §8).
3. Sanity-check daily transit counts against published figures.

## Roadmap

- [x] M1 Ingest + schema
- [x] M2 Transit detection + dark-vessel detection, unit tested (calibration soak still needed)
- [x] M3 API (`src/api.js`) + map frontend (`web/`) ← you are here (not yet deployed behind a domain/TLS)
- [ ] M4 Terraform + GitHub Actions + monitoring
- [ ] M5 Launch
