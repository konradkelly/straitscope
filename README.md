# Strait Tracker

Real-time Strait of Hormuz vessel traffic monitor with route-split classification
(northern "Route of Authority" vs. southern Omani corridor).

**Read `spec.md` first** — it's the authoritative design doc.

## Quick start

```bash
cp .env.example .env      # add your free aisstream.io API key + a db password
docker compose up -d      # db + ingest + worker
docker compose logs -f ingest
```

Positions start landing in `vessel_positions` within seconds. The worker
detects completed transits every 5 minutes.

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

- [ ] M1 Ingest + schema ← you are here
- [ ] M2 Transit detection calibration soak
- [ ] M3 API (`src/api.js`) + map frontend (`web/`)
- [ ] M4 Terraform + GitHub Actions + monitoring
- [ ] M5 Launch
