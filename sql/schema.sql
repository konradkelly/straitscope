-- Strait Tracker schema
-- Requires: PostgreSQL 15+ with TimescaleDB extension (timescale/timescaledb Docker image)

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------------------------------------------------------------------------
-- Vessel registry (upserted from ShipStaticData messages)
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
    corridor  TEXT NOT NULL DEFAULT 'outside'  -- northern | southern | outside
);

SELECT create_hypertable('vessel_positions', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_positions_mmsi_time
    ON vessel_positions (mmsi, time DESC);

-- Keep raw positions for 30 days; aggregates live forever.
SELECT add_retention_policy('vessel_positions', INTERVAL '30 days', if_not_exists => TRUE);

-- ---------------------------------------------------------------------------
-- Completed transits (one row per end-to-end passage)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transits (
    id           BIGSERIAL PRIMARY KEY,
    mmsi         BIGINT NOT NULL,
    direction    TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    entered_at   TIMESTAMPTZ NOT NULL,
    exited_at    TIMESTAMPTZ NOT NULL,
    route        TEXT NOT NULL CHECK (route IN ('northern', 'southern', 'mixed')),
    n_positions  INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transits_exited ON transits (exited_at DESC);

-- ---------------------------------------------------------------------------
-- Per-vessel transit detector state (survives worker restarts)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transit_state (
    mmsi            BIGINT PRIMARY KEY,
    state           TEXT NOT NULL DEFAULT 'IDLE',   -- IDLE | IN_STRAIT
    entered_gate    TEXT,                           -- west | east
    entered_at      TIMESTAMPTZ,
    last_lat        DOUBLE PRECISION,
    last_lon        DOUBLE PRECISION,
    last_time       TIMESTAMPTZ,
    northern_count  INT NOT NULL DEFAULT 0,         -- in-strait corridor tallies
    southern_count  INT NOT NULL DEFAULT 0,
    total_count     INT NOT NULL DEFAULT 0,
    last_sog        REAL,                           -- sog at last position (spec §6.4 dark check)
    dark_flagged    BOOLEAN NOT NULL DEFAULT false   -- true once current silence has been logged
);

-- ---------------------------------------------------------------------------
-- Dark-vessel events (spec §6.4): a moving vessel (sog > 1 kn) goes silent
-- for > 6h without having exited via a gate. Logged once per occurrence (not
-- continuously re-logged) so historical daily counts stay accurate even
-- after transit_state later resets.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dark_events (
    id            BIGSERIAL PRIMARY KEY,
    mmsi          BIGINT NOT NULL,
    last_seen_at  TIMESTAMPTZ NOT NULL,   -- last position before going quiet
    detected_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dark_events_detected ON dark_events (detected_at DESC);

-- Watermark so the worker processes each position batch exactly once.
CREATE TABLE IF NOT EXISTS worker_watermark (
    id            INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    processed_to  TIMESTAMPTZ NOT NULL
);

INSERT INTO worker_watermark (id, processed_to)
VALUES (1, now() - INTERVAL '1 hour')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Daily rollup (refreshed by the worker after each detection pass)
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS daily_stats AS
SELECT
    date_trunc('day', exited_at)::date AS day,
    direction,
    route,
    count(*)             AS transit_count,
    count(DISTINCT mmsi) AS distinct_vessels
FROM transits
GROUP BY 1, 2, 3
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_stats
    ON daily_stats (day, direction, route);

-- Refresh with: REFRESH MATERIALIZED VIEW CONCURRENTLY daily_stats;
