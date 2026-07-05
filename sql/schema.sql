-- Strait Tracker schema
-- Requires: PostgreSQL 15+ with TimescaleDB extension (timescale/timescaledb Docker image)
--
-- Safe to re-run against an already-initialized database: every CREATE is
-- IF NOT EXISTS, and each table's ALTER TABLE ... ADD COLUMN IF NOT EXISTS
-- brings a pre-multi-region (before 2026-07-04) database forward in place.
-- The ALTER immediately follows its table's CREATE so that later statements
-- in this file (indexes, the daily_stats view) can rely on the column
-- already existing, whichever path got it there.

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------------------------------------------------------------------------
-- Vessel registry (upserted from ShipStaticData messages). Not region-scoped
-- — a vessel keeps one identity as it moves between regions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vessels (
    mmsi            BIGINT PRIMARY KEY,
    name            TEXT,
    ship_type       INT,                -- raw AIS type code
    ship_type_class TEXT,               -- derived: tanker | cargo | other
    flag            TEXT,               -- derived from MMSI MID prefix
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Position time series (hypertable, append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vessel_positions (
    time      TIMESTAMPTZ NOT NULL,
    mmsi      BIGINT NOT NULL,
    lat       DOUBLE PRECISION NOT NULL,
    lon       DOUBLE PRECISION NOT NULL,
    sog       REAL,                     -- speed over ground (knots)
    cog       REAL,                     -- course over ground (degrees)
    heading   SMALLINT,
    region    TEXT NOT NULL DEFAULT 'hormuz',    -- see src/geo.js REGIONS
    corridor  TEXT NOT NULL DEFAULT 'outside'    -- region-specific corridor name, or outside/unclassified
);

ALTER TABLE vessel_positions ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT 'hormuz';

SELECT create_hypertable('vessel_positions', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_positions_mmsi_time
    ON vessel_positions (mmsi, time DESC);

CREATE INDEX IF NOT EXISTS idx_positions_region_time
    ON vessel_positions (region, time DESC);

-- Keep raw positions for 30 days; aggregates live forever.
SELECT add_retention_policy('vessel_positions', INTERVAL '30 days', if_not_exists => TRUE);

-- ---------------------------------------------------------------------------
-- Completed transits (one row per end-to-end passage)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transits (
    id           BIGSERIAL PRIMARY KEY,
    mmsi         BIGINT NOT NULL,
    region       TEXT NOT NULL DEFAULT 'hormuz',
    direction    TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    entered_at   TIMESTAMPTZ NOT NULL,
    exited_at    TIMESTAMPTZ NOT NULL,
    -- Region-specific vocabulary (e.g. hormuz: northern/southern/mixed;
    -- singapore: unclassified) — validated in worker.js, not a DB enum,
    -- since each region defines its own corridor names.
    route        TEXT NOT NULL,
    n_positions  INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE transits ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT 'hormuz';

-- The old `route TEXT ... CHECK (route IN ('northern','southern','mixed'))`
-- constraint doesn't hold once other regions define their own route
-- vocabulary (e.g. singapore's 'unclassified') — drop it if present.
ALTER TABLE transits DROP CONSTRAINT IF EXISTS transits_route_check;

CREATE INDEX IF NOT EXISTS idx_transits_region_exited ON transits (region, exited_at DESC);

-- ---------------------------------------------------------------------------
-- Per-vessel transit detector state (survives worker restarts). Keyed by
-- (region, mmsi): the same physical ship gets independent state machines in
-- each region it passes through.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transit_state (
    region          TEXT NOT NULL DEFAULT 'hormuz',
    mmsi            BIGINT NOT NULL,
    state           TEXT NOT NULL DEFAULT 'IDLE',   -- IDLE | IN_STRAIT
    entered_gate    TEXT,                           -- region-specific gate name
    entered_at      TIMESTAMPTZ,
    last_lat        DOUBLE PRECISION,
    last_lon        DOUBLE PRECISION,
    last_time       TIMESTAMPTZ,
    northern_count  INT NOT NULL DEFAULT 0,         -- in-strait corridor tallies (region-specific meaning)
    southern_count  INT NOT NULL DEFAULT 0,
    total_count     INT NOT NULL DEFAULT 0,
    last_sog        REAL,                           -- sog at last position (spec §6.4 dark check)
    dark_flagged    BOOLEAN NOT NULL DEFAULT false,  -- true once current silence has been logged
    PRIMARY KEY (region, mmsi)
);

ALTER TABLE transit_state ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT 'hormuz';

-- Swap the old mmsi-only PK for (region, mmsi) if this table predates
-- multi-region support. Postgres has no ADD CONSTRAINT IF NOT EXISTS, so
-- check the current definition first.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'transit_state_pkey'
        AND conrelid = 'transit_state'::regclass
        AND pg_get_constraintdef(oid) = 'PRIMARY KEY (region, mmsi)'
    ) THEN
        ALTER TABLE transit_state DROP CONSTRAINT IF EXISTS transit_state_pkey;
        ALTER TABLE transit_state ADD PRIMARY KEY (region, mmsi);
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Dark-vessel events (spec §6.4): a moving vessel (sog > 1 kn) goes silent
-- for > 6h without having exited via a gate. Logged once per occurrence (not
-- continuously re-logged) so historical daily counts stay accurate even
-- after transit_state later resets.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dark_events (
    id            BIGSERIAL PRIMARY KEY,
    mmsi          BIGINT NOT NULL,
    region        TEXT NOT NULL DEFAULT 'hormuz',
    last_seen_at  TIMESTAMPTZ NOT NULL,   -- last position before going quiet
    detected_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE dark_events ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT 'hormuz';

CREATE INDEX IF NOT EXISTS idx_dark_events_region_detected ON dark_events (region, detected_at DESC);

-- Watermark so the worker processes each position batch exactly once.
-- Shared across regions: one pass reads all regions' new positions in a
-- single time-ordered sweep, and each row carries its own `region`.
CREATE TABLE IF NOT EXISTS worker_watermark (
    id            INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    processed_to  TIMESTAMPTZ NOT NULL
);

INSERT INTO worker_watermark (id, processed_to)
VALUES (1, now() - INTERVAL '1 hour')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Daily rollup (refreshed by the worker after each detection pass).
-- Materialized views can't take ADD COLUMN, so on schema change this is
-- dropped and recreated from `transits` (the source of truth) rather than
-- migrated in place — cheap and lossless since it's a pure derived aggregate.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS daily_stats;

CREATE MATERIALIZED VIEW daily_stats AS
SELECT
    date_trunc('day', exited_at)::date AS day,
    region,
    direction,
    route,
    count(*)             AS transit_count,
    count(DISTINCT mmsi) AS distinct_vessels
FROM transits
GROUP BY 1, 2, 3, 4
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_stats
    ON daily_stats (day, region, direction, route);

-- Refresh with: REFRESH MATERIALIZED VIEW CONCURRENTLY daily_stats;
