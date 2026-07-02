# Strait Tracker — v1 Specification

Real-time monitoring dashboard for vessel traffic through the Strait of Hormuz, with route-split classification (Iranian "Route of Authority" vs. the southern Omani corridor), daily transit counts, and a curated incident timeline.

**Author:** Konrad Kelly
**Status:** Draft v1
**Last updated:** 2026-07-01

---

## 1. Goals and Non-Goals

### 1.1 Goals

1. Ingest live AIS position data for the Strait of Hormuz region and persist it durably.
2. Detect **completed transits** (a vessel passing through the strait end-to-end) and count them per day.
3. Classify each transit by **route corridor**: `northern` (Iranian waters / "Route of Authority"), `southern` (Omani coastal corridor), or `mixed/unknown`.
4. Serve a public dashboard: live vessel map, daily transit chart with route split, headline stats, incident timeline.
5. Demonstrate production DevOps practices: IaC (Terraform), CI/CD (GitHub Actions), monitoring, and a documented runbook.

### 1.2 Non-Goals (v1)

- **No navigational use.** Prominent disclaimer required (see §8).
- No satellite AIS (S-AIS). Terrestrial/volunteer feeds only; coverage gaps are expected and surfaced honestly.
- No historical backfill before launch date.
- No user accounts, alerts, or paid tiers.
- No automated news/incident scraping — incidents are curated manually via a YAML file in the repo (PR = publish).
- No prediction, ETA estimation, or oil-price analytics.

---

## 2. Success Metrics

| Metric | Target |
|---|---|
| Ingestion uptime | ≥ 99% over rolling 7 days |
| Position → visible on map latency | < 60 s |
| Daily transit count accuracy | Within ±15% of published Kpler/MarineTraffic figures (sanity check, not SLA) |
| Time to ship v1 | ≤ 14 days from repo init |
| Page load (dashboard, cold) | < 3 s on 4G |

---

## 3. System Architecture

```
┌──────────────┐    websocket     ┌──────────────┐
│ AISStream.io │ ───────────────► │  Ingest svc  │
│  (free AIS)  │                  │  (Node.js)   │
└──────────────┘                  └──────┬───────┘
                                         │ INSERT (batched)
                                         ▼
                                  ┌──────────────┐
                                  │  PostgreSQL  │
                                  │ + TimescaleDB│
                                  └──────┬───────┘
                                         │
                    ┌────────────────────┼─────────────────────┐
                    ▼                    ▼                     ▼
             ┌────────────┐      ┌──────────────┐      ┌─────────────┐
             │ Transit    │      │  API (REST)  │      │  pg_cron /  │
             │ detector   │      │  Fastify     │      │  retention  │
             │ (worker)   │      └──────┬───────┘      └─────────────┘
             └────────────┘             │  JSON (cached)
                                        ▼
                                 ┌──────────────┐
                                 │  Frontend    │
                                 │ MapLibre +   │
                                 │ static site  │
                                 └──────────────┘
```

**Deployment shape (v1):** one small VM (t3.small or equivalent) running Docker Compose with four containers: `db`, `ingest`, `worker`, `api`. Frontend deployed as static files to S3+CloudFront (or the same VM behind Caddy). Terraform provisions the VM, security groups, and DNS. GitHub Actions builds images and deploys over SSH (same pattern as Cascadia Gear Co-op).

Rationale: a single always-on websocket consumer does not justify ECS/EKS. Keep it boring; the resume value is in the pipeline correctness and the runbook, not in cluster orchestration.

---

## 4. Data Sources

### 4.1 AIS positions — AISStream.io

- Free websocket API (`wss://stream.aisstream.io/v0/stream`), API key required.
- Subscribe with a bounding box and message-type filter.
- **Region of interest (ROI):** `[[25.0, 54.5], [27.8, 58.5]]` (lat, lon pairs; SW → NE corners). Covers the Persian Gulf approach, the strait itself, and the Gulf of Oman approach.
- Message types consumed: `PositionReport` (types 1/2/3), `ShipStaticData` (type 5) for names/types.
- **Known limitations:** volunteer terrestrial receiver network → coverage gaps, especially mid-channel and during conflict (vessels going dark / AIS spoofing). These gaps are a *feature to display* ("vessels gone dark in last 24 h"), not something to hide.

### 4.2 Incidents — manual curation

- `data/incidents.yaml` in the repo. Each entry: `date`, `title`, `summary`, `lat/lon (optional)`, `source_url`, `severity (info|attack|grounding|seizure)`.
- Sources: IMO reports, UKMTO warnings, reputable press. Adding an incident = opening a PR (audit trail for free).

### 4.3 Explicitly out of scope

- MarineTraffic / Kpler / Windward APIs (paid, restrictive ToS on republication).
- Any scraping of commercial trackers.

---

## 5. Data Model

See `sql/schema.sql` for authoritative DDL. Summary:

### 5.1 `vessels`
Static registry keyed by MMSI. Upserted from `ShipStaticData` messages.

| column | type | notes |
|---|---|---|
| mmsi | bigint PK | |
| name | text | latest reported |
| ship_type | int | AIS type code |
| ship_type_class | text | derived: `tanker`, `cargo`, `other` |
| flag | text | derived from MMSI MID prefix |
| first_seen / last_seen | timestamptz | |

### 5.2 `vessel_positions` (hypertable)
Append-only time series, partitioned by time.

| column | type | notes |
|---|---|---|
| time | timestamptz | AIS report time |
| mmsi | bigint | FK-ish (not enforced, ingest speed) |
| lat / lon | double precision | |
| sog | real | speed over ground, knots |
| cog | real | course over ground |
| heading | smallint | |
| corridor | text | `northern` / `southern` / `outside` — computed at insert |

Retention: raw positions kept 30 days (Timescale retention policy); aggregates kept forever.

### 5.3 `transits`
One row per completed end-to-end passage.

| column | type | notes |
|---|---|---|
| id | bigserial PK | |
| mmsi | bigint | |
| direction | text | `inbound` (Gulf of Oman → Persian Gulf) / `outbound` |
| entered_at / exited_at | timestamptz | gate-crossing timestamps |
| route | text | `northern` / `southern` / `mixed` |
| n_positions | int | sample count during transit (quality signal) |

### 5.4 `daily_stats` (continuous aggregate or materialized view)
`day, direction, route, transit_count, distinct_vessels, dark_vessel_count`.

---

## 6. Core Algorithms

### 6.1 Gate lines

Two virtual gate segments across the shipping approaches:

- **West gate (Persian Gulf side):** segment ~ (26.55°N, 55.70°E) → (25.90°N, 55.70°E)
- **East gate (Gulf of Oman side):** segment ~ (26.10°N, 57.10°E) → (25.30°N, 57.10°E)

A vessel's consecutive position pair (p₁, p₂) **crosses a gate** if the segment p₁→p₂ intersects the gate segment (standard 2-D segment intersection; the geographic distortion at this scale is negligible for detection purposes).

> Gate coordinates above are engineering placeholders — calibrate against a few days of real traffic before launch and record final values in `src/geo.js`.

### 6.2 Transit state machine (per MMSI)

```
IDLE ──cross west gate──► IN_STRAIT(expect=east)  ──cross east gate──► TRANSIT(outbound) → IDLE
IDLE ──cross east gate──► IN_STRAIT(expect=west) ──cross west gate──► TRANSIT(inbound)  → IDLE
IN_STRAIT ──no positions for 48 h── ► ABANDONED → IDLE   (vessel dark or anchored; no transit recorded)
IN_STRAIT ──re-cross same gate──► IDLE            (turned back; no transit recorded)
```

Runs in the `worker` process every 5 minutes over positions since the last watermark. State persisted in a `transit_state` table so restarts are safe (idempotent by watermark).

### 6.3 Route classification

Two hand-drawn corridor polygons stored as GeoJSON in `src/geo.js`:

- `NORTHERN_CORRIDOR` — traditional TSS lanes / Iranian-waters routing.
- `SOUTHERN_CORRIDOR` — Omani coastal corridor.

Each position gets a point-in-polygon check at insert time (ray casting; polygons have < 30 vertices, cost is negligible). A transit's `route` is:

- `northern` if ≥ 70% of in-strait positions fall in the northern polygon
- `southern` if ≥ 70% fall in the southern polygon
- `mixed` otherwise

> Polygon vertices in the scaffold are rough placeholders. Calibrate by plotting a week of real tracks and tracing the two observed lanes. This calibration is the single most important pre-launch task — the route split is the product's differentiator.

### 6.4 "Gone dark" metric

A vessel is *dark* if it was seen inside the ROI moving (sog > 1 kn) and then produced no positions for > 6 h without having exited via a gate. Computed by the worker; displayed as a 24 h count with the honest caveat that receiver coverage gaps also cause this.

---

## 7. API

Fastify, JSON, all responses cached (in-process LRU + `Cache-Control`).

| endpoint | cache | returns |
|---|---|---|
| `GET /api/v1/live` | 30 s | latest position per vessel seen in last 2 h (map dots) |
| `GET /api/v1/stats/daily?days=30` | 5 min | daily transit counts by direction and route |
| `GET /api/v1/stats/headline` | 5 min | today's transits, 7-day avg, route split %, dark count |
| `GET /api/v1/incidents` | 5 min | curated incident list |
| `GET /api/v1/vessel/:mmsi/track?hours=24` | 60 s | recent track for click-through |
| `GET /healthz` | none | ingest lag, db status, last message age |

Rate limiting: 60 req/min/IP at the Caddy/CloudFront layer. No auth in v1.

---

## 8. Frontend

Static SPA (Vite + React or plain Vite + vanilla — builder's choice; no SSR).

**Layout (single page):**
1. Headline stat bar — today's transits, 7-day average, northern/southern split %, vessels gone dark (24 h).
2. MapLibre GL map — live vessel dots (colored by type), corridor polygon overlays (toggleable), gate lines, incident markers.
3. Daily transit chart — stacked bars (northern/southern/mixed) over 30 days, Recharts or D3.
4. Incident timeline — reverse-chronological list from `incidents.yaml`.
5. Footer — data-source attribution, methodology link, and disclaimer.

**Mandatory disclaimer (footer + first-visit banner):**
> "Not for navigation. Positions come from volunteer terrestrial AIS receivers and may be delayed, incomplete, or spoofed. Transit counts are estimates."

---

## 9. Infrastructure & Operations

- **Terraform:** VPC-lite (default VPC acceptable), one EC2 instance, security group (80/443 + SSH from admin IP), Elastic IP, Route 53 records. State in S3 backend.
- **CI/CD (GitHub Actions):**
  - PR: lint + unit tests (transit state machine and point-in-polygon get real tests — they're the correctness core).
  - `main`: build Docker images → push to GHCR → SSH deploy → `docker compose up -d` → smoke-check `/healthz`.
- **Monitoring:** UptimeRobot (or similar) on `/healthz`; the endpoint returns non-200 if the last AIS message is older than 5 min. Optional: a tiny cron that posts daily stats to a private Discord webhook — doubles as a "is it alive" signal.
- **Backups:** nightly `pg_dump` of `transits`, `daily_stats`, `vessels` to S3 (raw positions are expendable).
- **Cost ceiling:** ~$20–25/month (t3.small + EBS + Route 53 + S3). If it goes viral, CloudFront in front of the API buys headroom before any re-architecture.

---

## 10. Milestones

| # | Deliverable | Est. |
|---|---|---|
| M1 | Ingest service writing positions to local Postgres; schema migrated | 2 days |
| M2 | Transit detection + route classification with unit tests; 3-day calibration soak | 4 days |
| M3 | API + minimal map frontend deployed behind domain, TLS | 4 days |
| M4 | Charts, incidents, disclaimer, polish; Terraform + CI complete | 3 days |
| M5 | Launch: README with architecture diagram, methodology page, post to r/dataisbeautiful / HN Show | 1 day |

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| News cycle ends (deal signed) | Brand as chokepoint tracker, not Hormuz-only; ROI is one config value — Bab el-Mandeb is a copy-paste expansion |
| AISStream outage / ToS change | Ingest is behind one module (`src/ais.js`); alternative feeds swappable. Show "data delayed" banner from `/healthz` state |
| Sparse receiver coverage mid-strait | Expected; transit detection uses gates near coasts where coverage is better; surface coverage honestly |
| Misclassification embarrassment | Publish methodology page; label counts as estimates; keep raw thresholds in one config file |
| Geopolitical sensitivity | Facts only: positions, counts, sourced incidents. No editorializing, no targeting-useful real-time detail beyond what public trackers already show |

---

## 12. Repository Layout

```
strait-tracker/
├── spec.md                  ← this document
├── docker-compose.yml
├── .env.example
├── sql/
│   └── schema.sql
├── src/
│   ├── ingest.js            ← AISStream websocket consumer
│   ├── worker.js            ← transit detector (5-min loop)
│   ├── api.js               ← Fastify REST API (M3)
│   ├── ais.js               ← feed abstraction
│   ├── geo.js               ← ROI, gates, corridors, point-in-polygon
│   └── db.js                ← pg pool + batched inserts
├── data/
│   └── incidents.yaml
├── web/                     ← frontend (M3)
├── terraform/               ← infra (M4)
└── .github/workflows/       ← CI/CD (M4)
```
