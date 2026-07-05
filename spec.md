# Strait Tracker — v1 Specification

Real-time monitoring dashboard for vessel traffic through global maritime chokepoints. Launched single-region (Strait of Hormuz, with route-split classification between the Iranian "Route of Authority" and the southern Omani corridor); now multi-region, with the Singapore Strait added as the second tracked chokepoint. Each region gets daily transit counts and a curated incident timeline; route-split classification is opt-in per region since it depends on there being a real politically-meaningful lane split (Hormuz has one, Singapore Strait doesn't).

**Author:** Konrad Kelly
**Status:** Draft v1
**Last updated:** 2026-07-04

---

## 1. Goals and Non-Goals

### 1.1 Goals

1. Ingest live AIS position data for one or more configured chokepoint regions and persist it durably.
2. Detect **completed transits** (a vessel passing through a region's strait end-to-end) and count them per day, per region.
3. Where a region has a real politically- or navigationally-distinct lane split, classify each transit by **route corridor** (e.g. Hormuz's `northern` Iranian-waters "Route of Authority" vs. `southern` Omani coastal corridor); regions without one report `unclassified` rather than forcing a meaningless label.
4. Serve a public dashboard with a **region switcher**: live vessel map, daily transit chart with route split (where applicable), headline stats, incident timeline — all scoped to the selected region.
5. Support adding a new region as a config change (`src/geo.js` `REGIONS`) plus real gate/corridor calibration, not a code fork — validated in practice by adding the Singapore Strait as the second region (§4.1.1).
6. Demonstrate production DevOps practices: IaC (Terraform), CI/CD (GitHub Actions), monitoring, and a documented runbook.

### 1.2 Non-Goals (v1)

- **No navigational use.** Prominent disclaimer required (see §8).
- No satellite AIS (S-AIS) *by default*. Terrestrial/volunteer feeds only. This is no longer a hypothetical caveat: §4.1.1's survey found the Strait of Hormuz has **zero** terrestrial AISStream coverage mid-channel, so its transit count is a confirmed, persistent zero until a satellite feed is integrated for that region specifically (tracked as future work, §11). Other regions are added only after the same empirical check confirms real coverage.
- No historical backfill before launch date.
- No user accounts, alerts, or paid tiers.
- No automated news/incident scraping — incidents are curated manually via a YAML file in the repo (PR = publish), tagged per region.
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
┌──────────────┐   websocket, N bboxes   ┌──────────────┐
│ AISStream.io │ ───────────────────────►│  Ingest svc  │
│  (free AIS)  │  (one subscription per  │  (Node.js)   │
└──────────────┘   region, see §4.1)     └──────┬───────┘
                                                │ findRegion(lon,lat) tags
                                                │ each row, INSERT (batched)
                                                ▼
                                         ┌──────────────┐
                                         │  PostgreSQL  │
                                         │ + TimescaleDB│
                                         │ (region col  │
                                         │  everywhere) │
                                         └──────┬───────┘
                                                │
                    ┌───────────────────────────┼─────────────────────┐
                    ▼                           ▼                     ▼
             ┌────────────┐            ┌──────────────┐      ┌─────────────┐
             │ Transit    │            │  API (REST)  │      │  pg_cron /  │
             │ detector   │            │  Fastify     │      │  retention  │
             │ (worker),  │            │  ?region=    │      └─────────────┘
             │ per (region,mmsi)       └──────┬───────┘
             └────────────┘                   │  JSON (cached per region)
                                               ▼
                                        ┌──────────────┐
                                        │  Frontend    │
                                        │ MapLibre +   │
                                        │ region switcher│
                                        └──────────────┘
```

**Deployment shape (v1):** one small VM (t3.small or equivalent) running Docker Compose with four containers: `db`, `ingest`, `worker`, `api`. Frontend deployed as static files to S3+CloudFront (or the same VM behind Caddy). Terraform provisions the VM, security groups, and DNS. GitHub Actions builds images and deploys over SSH (same pattern as Cascadia Gear Co-op).

Rationale: a single always-on websocket consumer does not justify ECS/EKS. Keep it boring; the resume value is in the pipeline correctness and the runbook, not in cluster orchestration. Adding a region is a config change (`src/geo.js` `REGIONS`) plus a schema no-op (the `region` column already exists everywhere) — it does not add a new container, VM, or websocket connection, since AISStream accepts multiple bounding boxes on one subscription.

---

## 4. Data Sources

### 4.1 AIS positions — AISStream.io

- Free websocket API (`wss://stream.aisstream.io/v0/stream`), API key required.
- Subscribe once, with **one bounding box per configured region** (`BoundingBoxes` accepts an array) and a message-type filter — one connection serves every region.
- Message types consumed: `PositionReport` (types 1/2/3), `ShipStaticData` (type 5) for names/types.
- **Known limitation:** AISStream is built entirely from volunteer-operated terrestrial AIS receivers (~200 km off populated coastlines, per their own docs) — there is no satellite component. Coverage therefore tracks *hobbyist-receiver density*, not shipping volume or a chokepoint's geopolitical importance.

#### 4.1.1 Coverage survey (2026-07-03/04)

Production launched with the Strait of Hormuz as the only region and recorded **zero transits in its first 9+ hours live**. Root-cause investigation (not a code bug — the ingest service, API, and frontend were all functioning correctly) found:

- `/healthz` showed `vessel_positions` had never received a single row.
- A fresh, direct AISStream connection from the production host, subscribed to Hormuz's ROI, received **0 messages in 45 s live** and **0 messages across the prior 9 hours** of ingest logs — despite the strait being one of the busiest tanker chokepoints on Earth.
- The same connection, subscribed **worldwide**, received 5,289 messages in 30 s — the API key and subscription mechanism work fine.
- AISStream's own published coverage map (`aisstream.io/coverage`) shows a complete visual void over the entire Persian Gulf / Arabian Peninsula / Iranian coastline, while Europe, North America, East Asia, and Australia are densely covered.

This prompted a broader empirical survey — the same live-connection test (subscribe, count raw messages over a fixed window, no code changes) — across other candidate chokepoints, to find out whether Hormuz's dead zone was a one-off or the norm:

| Region | Test window | Messages | Verdict |
|---|---|---|---|
| Strait of Hormuz | 9 h (prod) + 45 s (fresh) | 0 | **Dead zone** |
| Bab-el-Mandeb | 60 s | 0 | **Dead zone** |
| Malacca Strait (narrowest point, One Fathom Bank) | 60 s | 0 | **Dead zone** — despite the Singapore Strait (same waterway, ~60 nm east) being excellent |
| Gibraltar | 60 s | 2 | Marginal — some coverage, thin |
| Dover Strait | 30 s | 10 | Good |
| Öresund (Denmark/Sweden) | 25 s | 16 | Excellent |
| **Singapore Strait** | 25 s | **24** | **Excellent — selected as region #2** |

**Conclusion:** coverage correlates with wealthy, densely populated, hobbyist-AIS-culture coastlines (Northern Europe, Singapore) — not with a chokepoint's shipping volume or news profile. Bab-el-Mandeb is currently the most geopolitically newsworthy strait in the world (Red Sea shipping disruption) and is exactly as dark as Hormuz, for the same reason: no nearby volunteer receivers. Malacca is the sharpest illustration that this is receiver-placement-specific, not region-wide — its narrowest, busiest point is dead even though the Singapore Strait end of the same waterway (~60 nm away) is one of the best-covered chokepoints tested.

**Process implication:** a region must pass this live-connection coverage check *before* any gate/corridor calibration work is done on it — "this general area seems well-populated" is not sufficient, since coverage can flip from excellent to zero within the same strait depending on exactly where the gate line sits.

**Path forward for Hormuz specifically (not yet built):** a satellite AIS feed is required to ever get real transit counts there. A provider survey (VesselFinder, Datalastic, Spire/Kpler, ORBCOMM/S&P, NavAPI, DataDocked, AISHub) found the market has consolidated into two enterprise-only platforms (Kpler, S&P Global) plus a handful of independent developer-tier APIs. VesselFinder is the leading candidate: an explicit, published per-record satellite AIS credit cost (10 credits/record vs. 1 for terrestrial) with no monthly minimum beyond a small initial credit purchase — the only option surveyed with both real satellite coverage and pay-as-you-go pricing suited to this project's scale. This is tracked as future work (§11), not implemented in this multi-region pass, which instead added Singapore Strait — a region that works today on the existing free feed.

### 4.2 Incidents — manual curation

- `data/incidents.yaml` in the repo. Each entry: `date`, `title`, `summary`, `lat/lon (optional)`, `region` (defaults to `hormuz` if omitted — see §5.1 region registry), `source_url`, `severity (info|attack|grounding|seizure)`.
- Sources: IMO reports, UKMTO warnings, reputable press. Adding an incident = opening a PR (audit trail for free).

### 4.3 Explicitly out of scope

- MarineTraffic / Kpler / Windward APIs (paid, restrictive ToS on republication).
- Any scraping of commercial trackers.

---

## 5. Data Model

See `sql/schema.sql` for authoritative DDL. Summary:

### 5.1 Region registry (`src/geo.js` `REGIONS`, not a DB table)

Every table below carries a `region TEXT` column (default `'hormuz'` for backward compatibility) whose valid values are the keys of the `REGIONS` config object — currently `hormuz` and `singapore`. Each entry defines: `roiBbox` (AISStream subscription box), `gates` (named gate line segments — a region can have any gate names, though `west`/`east` is the convention so far), `corridors` (optional named polygons for route classification — `null` if the region has no politically-distinct lane split), `routeThreshold`, and frontend map center/zoom. Adding a region is an entry in this object plus real gate/corridor calibration — see §4.1.1 for the coverage check that must pass first.

### 5.2 `vessels`
Static registry keyed by MMSI. Not region-scoped — a vessel keeps one identity as it moves between regions. Upserted from `ShipStaticData` messages.

| column | type | notes |
|---|---|---|
| mmsi | bigint PK | |
| name | text | latest reported |
| ship_type | int | AIS type code |
| ship_type_class | text | derived: `tanker`, `cargo`, `other` |
| flag | text | derived from MMSI MID prefix |
| first_seen / last_seen | timestamptz | |

### 5.3 `vessel_positions` (hypertable)
Append-only time series, partitioned by time.

| column | type | notes |
|---|---|---|
| time | timestamptz | AIS report time |
| mmsi | bigint | FK-ish (not enforced, ingest speed) |
| lat / lon | double precision | |
| sog | real | speed over ground, knots |
| cog | real | course over ground |
| heading | smallint | |
| region | text | which `REGIONS` entry this position's bbox matched, at insert time |
| corridor | text | region-specific corridor name, or `outside` / `unclassified` — computed at insert |

Retention: raw positions kept 30 days (Timescale retention policy); aggregates kept forever.

### 5.4 `transits`
One row per completed end-to-end passage.

| column | type | notes |
|---|---|---|
| id | bigserial PK | |
| mmsi | bigint | |
| region | text | |
| direction | text | `inbound` / `outbound` — meaning is region-specific (see §6.2) |
| entered_at / exited_at | timestamptz | gate-crossing timestamps |
| route | text | region-specific vocabulary (hormuz: `northern`/`southern`/`mixed`; singapore: `unclassified`) — validated in `worker.js`, not a DB enum, since it varies per region |
| n_positions | int | sample count during transit (quality signal) |

### 5.5 `transit_state`
Per-vessel detector state, **keyed by `(region, mmsi)`** — the same physical ship gets an independent state machine in each region it passes through (in practice these ROIs are geographically far apart, but the key exists in case that ever changes).

### 5.6 `daily_stats` (materialized view)
`day, region, direction, route, transit_count, distinct_vessels`.

---

## 6. Core Algorithms

### 6.1 Gate lines

Each region defines named gate line segments in `src/geo.js` `REGIONS[key].gates`. A vessel's consecutive position pair (p₁, p₂) **crosses a gate** if the segment p₁→p₂ intersects the gate segment (standard 2-D segment intersection; the geographic distortion at this scale is negligible for detection purposes). `crossedGate(regionKey, p1, p2)` checks only that region's gates, so a Hormuz-area crossing can never spuriously trip a Singapore gate (their ROIs are disjoint bounding boxes, so this is somewhat moot in practice, but it's how multiple regions coexist safely in one worker pass).

Current gate definitions:

| Region | West gate | East gate |
|---|---|---|
| Hormuz | (26.55°N, 55.70°E) → (25.90°N, 55.70°E) — Persian Gulf side | (26.10°N, 57.10°E) → (25.30°N, 57.10°E) — Gulf of Oman side |
| Singapore | (1.28°N, 103.75°E) → (1.05°N, 103.75°E) — near Raffles Lighthouse, Malacca Strait transition | (1.35°N, 104.10°E) → (1.15°N, 104.10°E) — near Horsburgh Lighthouse, South China Sea transition |

> All gate coordinates above are engineering placeholders — calibrate against a few days of real traffic before trusting the counts, and record final values in `src/geo.js`. This was already true for Hormuz pre-launch and is equally true for Singapore now.

### 6.2 Transit state machine (per `(region, mmsi)`)

```
IDLE ──cross west gate──► IN_STRAIT(expect=east)  ──cross east gate──► TRANSIT(outbound) → IDLE
IDLE ──cross east gate──► IN_STRAIT(expect=west) ──cross west gate──► TRANSIT(inbound)  → IDLE
IN_STRAIT ──no positions for 48 h── ► ABANDONED → IDLE   (vessel dark or anchored; no transit recorded)
IN_STRAIT ──re-cross same gate──► IDLE            (turned back; no transit recorded)
```

`direction` is always derived the same way (`entered_gate === 'west' ? 'outbound' : 'inbound'`) but its real-world meaning is region-specific: for Hormuz, outbound means Persian Gulf → Gulf of Oman; for Singapore, outbound means Malacca Strait → South China Sea. Runs in the `worker` process every 5 minutes over positions since the last watermark (shared across regions — one time-ordered sweep, each row already tagged with its own `region`). State persisted in `transit_state`, keyed by `(region, mmsi)`, so restarts are safe (idempotent by watermark).

### 6.3 Route classification

Optional per region. A region with named corridors (currently only Hormuz) gets two hand-drawn polygons stored as GeoJSON in `src/geo.js` (`REGIONS.hormuz.corridors.northern` / `.southern` — traditional TSS lanes / Iranian-waters routing vs. the Omani coastal corridor). Each position gets a point-in-polygon check at insert time (ray casting; polygons have < 30 vertices, cost is negligible). A transit's `route` is:

- `northern` if ≥ 70% of in-strait positions fall in the northern polygon
- `southern` if ≥ 70% fall in the southern polygon
- `mixed` otherwise

A region with **no** corridors defined (`REGIONS[key].corridors === null`, currently Singapore) always reports `route: 'unclassified'` — there's no Hormuz-style politically-distinct lane split to classify there, and forcing one would be product dishonesty, not a real signal.

> Hormuz's polygon vertices are rough placeholders. Calibrate by plotting a week of real tracks and tracing the two observed lanes. This calibration is the single most important pre-launch task for any region that wants a real route split — it's the product's differentiator where it applies.

### 6.4 "Gone dark" metric

A vessel is *dark* if it was seen inside a region's ROI moving (sog > 1 kn) and then produced no positions for > 6 h without having exited via a gate. Computed by the worker per region; displayed as a 24 h count with the honest caveat that receiver coverage gaps also cause this — see §4.1.1 for just how large those gaps can be.

---

## 7. API

Fastify, JSON, all responses cached per-region (in-process LRU + `Cache-Control`). Every endpoint below except `/api/v1/regions` and `/healthz` takes a `?region=` query param (default `hormuz`); an unknown region returns `400` with the list of known regions.

| endpoint | cache | returns |
|---|---|---|
| `GET /api/v1/regions` | none | list of configured regions: key, name, map center/zoom, gates, corridors — lets the frontend build a region switcher without duplicating `geo.js` |
| `GET /api/v1/live?region=` | 30 s | latest position per vessel seen in last 2 h, within the region (map dots) |
| `GET /api/v1/stats/daily?region=&days=30` | 5 min | daily transit counts by direction and route, within the region |
| `GET /api/v1/stats/headline?region=` | 5 min | today's transits, 7-day avg, route split % (whatever routes the region actually uses), dark count |
| `GET /api/v1/incidents?region=` | 5 min | curated incident list filtered to the region |
| `GET /api/v1/vessel/:mmsi/track?region=&hours=24` | 60 s | recent track for click-through, within the region |
| `GET /healthz` | none | ingest lag, db status, last message age (global, not region-scoped) |

Rate limiting: 60 req/min/IP at the Caddy/CloudFront layer. No auth in v1.

---

## 8. Frontend

Static SPA (Vite + vanilla JS; no framework, no SSR).

**Layout (single page):**
1. **Region switcher** — a `<select>` in the header (populated from `src/geo.js` `REGIONS`, imported directly rather than round-tripping through `/api/v1/regions`, matching the map module's existing pattern). Switching region recenters/rezooms the map, swaps the corridor/gate overlays, and re-fetches every data section below for the new region. Choice persists in `localStorage`.
2. Headline stat bar — today's transits, 7-day average, route split % (rendered from whatever route names the current region's API response actually contains — `northern`/`southern`/`mixed` for Hormuz, `unclassified` for Singapore — not hardcoded to Hormuz's vocabulary), vessels gone dark (24 h).
3. MapLibre GL map — live vessel dots (colored by type), corridor polygon overlays (toggleable, empty for regions with no corridors), gate lines, incident markers.
4. Daily transit chart — stacked bars over 30 days, colors/legend/table columns generated from whatever route names are present in the response (known names get fixed colors; anything else falls back to a rotating palette) rather than assuming Hormuz's three-route set.
5. Incident timeline — reverse-chronological list from `incidents.yaml`, filtered to the selected region.
6. Footer — data-source attribution, methodology link, and disclaimer.

**Mandatory disclaimer (footer + first-visit banner):**
> "Not for navigation. Positions come from volunteer terrestrial AIS receivers and may be delayed, incomplete, or spoofed. Transit counts are estimates."

---

## 9. Infrastructure & Operations

- **Terraform:** VPC-lite (default VPC acceptable), one EC2 instance, security group (80/443 public; no inbound SSH — see below), Elastic IP, Route 53 hosted zone + records, GitHub OIDC-assumable deploy role, S3 buckets for deploy artifacts and backups. State in S3 backend.
- **DNS:** domain is registered at Hostinger; Hostinger stays the registrar. DNS resolution is delegated to a Route 53 hosted zone (Hostinger's nameservers repointed to Route 53's 4 NS records), so all records (A/CNAME for the app, anything else needed later) live in Terraform state alongside the rest of the infra rather than being managed by hand at the registrar. Do this delegation *before* the first deploy — Caddy's Let's Encrypt cert issuance validates over HTTP against live DNS, so a stale or unpropagated record will fail the cert request.
- **CI/CD (GitHub Actions):**
  - PR: lint + unit tests (transit state machine and point-in-polygon get real tests — they're the correctness core).
  - `main`: build Docker images → push to GHCR → upload release artifacts to S3 → GitHub Actions assumes an AWS role via OIDC (no static AWS keys) → `aws ssm send-command` runs `docker compose up -d` on the box → smoke-check `/healthz`.
  - No inbound SSH anywhere, including from CI: the security group has no port-22 ingress rule. Admin/ad hoc shell access is via `aws ssm start-session` (Session Manager), not SSH — migrated 2026-07-05.
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
| M6 | Multi-region refactor: `REGIONS` config, region column across schema/API/frontend, region switcher; Singapore Strait added as region #2 after passing the §4.1.1 coverage check | done 2026-07-04 |

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| News cycle ends (deal signed) | **Done, not hypothetical:** brand as chokepoint tracker, not Hormuz-only. Multi-region support landed 2026-07-04 (`REGIONS` config in `src/geo.js`); Singapore Strait is region #2. Bab-el-Mandeb was evaluated and explicitly **rejected for now** — see next row. |
| AISStream outage / ToS change | Ingest is behind one module (`src/ingest.js` + `src/geo.js`); alternative feeds swappable. Show "data delayed" banner from `/healthz` state |
| Terrestrial coverage gaps, incl. total dead zones | **Revised after §4.1.1's survey — the original "gates near coasts have better coverage" mitigation was wrong for Hormuz.** Coastal Hormuz gates get zero coverage because there are no nearby volunteer receivers at all (Iranian/Omani coastline), not because mid-channel is specifically harder than the coastline. The real mitigation: **empirically test any candidate region's live AISStream coverage before building gates/corridors for it** (§4.1.1's method — subscribe, count raw messages over a fixed window). This is now a hard gate before adding a region, not an assumption. Confirmed dead so far: Hormuz, Bab-el-Mandeb, Malacca Strait's narrowest point. Confirmed good: Singapore Strait, Dover Strait, Öresund. Fixing Hormuz specifically requires a satellite AIS feed (candidate: VesselFinder, ~€330 min, explicit per-record satellite pricing) — not yet implemented. |
| Misclassification embarrassment | Publish methodology page; label counts as estimates; keep raw thresholds in one config file (per-region, in `REGIONS`) |
| Geopolitical sensitivity | Facts only: positions, counts, sourced incidents. No editorializing, no targeting-useful real-time detail beyond what public trackers already show |
| A new region "looks" well-covered but isn't (Malacca-Strait-shaped surprise) | Never trust general area reputation or shipping-volume fame. Always run the live coverage test at the *exact* candidate gate coordinates, not just "somewhere in the strait" — coverage can flip from excellent to zero within the same waterway (§4.1.1) |
| Postgres data lives only on the instance's root EBS volume, with no separate persistent volume | Any EC2 instance replacement (deliberate — instance type change, AMI update — or accidental) destroys the database with no restore path beyond the nightly S3 `pg_dump` (§9). There's also a currently-pending, deliberately-unapplied Terraform diff on `user_data.sh.tftpl` (adds SSM Agent + AWS CLI install steps, done live via SSM instead — see 2026-07-05 commits) that would trigger exactly this replacement if a plain `terraform apply` is ever run without `-target`, since `user_data_replace_on_change = true`. **Planned fix, deferred to one deliberate maintenance window (not urgent, no functional impact today):** (1) verify a fresh `pg_dump` has landed in the S3 backups bucket, (2) provision a separate persistent EBS volume for `/var/lib/postgresql/data` (or the Docker volume backing it) decoupled from instance lifecycle, migrate the data onto it, (3) only then let the pending `user_data` diff apply (accept the instance replacement — it's now harmless since data lives on the separate volume), (4) bundle in the cosmetic `security_group.tf` `description` update (currently stale, still says "SSH from admin IP" — harmless text-only fix that happens to also force an SG replace, so it's free to do in the same window) at the same time. Until this window happens, treat any Terraform change touching `aws_instance.app` as requiring a fresh backup first and a careful `terraform plan` review for the `user_data` diff. |

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
│   ├── ingest.js            ← AISStream websocket consumer (subscribes all regions at once)
│   ├── worker.js            ← transit detector (5-min loop, per (region, mmsi))
│   ├── api.js               ← Fastify REST API (M3), region-scoped
│   ├── geo.js               ← REGIONS config: per-region ROI/gates/corridors, point-in-polygon (M6)
│   └── db.js                ← pg pool + batched inserts
├── data/
│   └── incidents.yaml       ← region-tagged
├── web/                     ← frontend (M3), region switcher (M6)
├── terraform/               ← infra (M4)
└── .github/workflows/       ← CI/CD (M4)
```
