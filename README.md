# Strait Tracker

Real-time vessel traffic monitor for global maritime chokepoints (Strait of
Hormuz, Singapore Strait, Strait of Dover, Gibraltar, Öresund), with
route-split classification where a region has a real lane split.

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

- [ ] **Calibrate geometry** — partially done. Singapore's gates and Dover's
   gates + Dover/Gibraltar's corridors are calibrated against live position
   data (spec §6.1/§6.3 and their addenda); Gibraltar's and Öresund's gates
   are still eyeballed placeholders, and Hormuz can't be calibrated at all
   while its terrestrial AIS coverage stays at zero (spec §4.1.1). Collect a
   few days of positions, then run `npm run export-tracks -- 3 tracks >
   tracks.geojson` and paste the result into
   [geojson.io](https://geojson.io) to see where vessels actually travel;
   redraw `GATES`/`CORRIDORS` in `src/geo.js` to match. Spec §6 explains why
   this matters.
- [x] Add the not-for-navigation disclaimer to the frontend (spec §8).
- [ ] Sanity-check daily transit counts against published figures. (Spec
   §6.1 addendum found and partly explained why counts run low — a lot of
   ROI traffic is anchorage/port-calling, not through-transit — but the
   figures haven't been checked against a published source yet.)
- [ ] Curate real entries in `data/incidents.yaml` — currently empty
   (example only), so the incident timeline renders nothing live.
- [ ] Wire up the nightly `pg_dump` → S3 backup (spec §9) — the S3 bucket
   and IAM policy exist in Terraform, but nothing runs the dump yet.

## Roadmap

- [x] M1 Ingest + schema
- [x] M2 Transit detection + dark-vessel detection, unit tested (calibration soak still needed)
- [x] M3 API (`src/api.js`) + map frontend (`web/`), deployed behind a domain + TLS
- [x] M4 Terraform + GitHub Actions — monitoring is still just external (UptimeRobot-style, not in repo) and backups aren't wired up yet (see above)
- [ ] M5 Launch (methodology page, public announcement)
- [x] M6 Multi-region refactor; Singapore Strait added as region #2 (done 2026-07-04)
- [x] M7 Dover Strait added as region #3 (done 2026-07-06)
- [x] M8 Gibraltar and Öresund added as regions #4/#5; Taiwan Strait evaluated and rejected (done 2026-07-07)
