/**
 * db.js — pg pool plus a small batching layer so a busy AIS feed doesn't
 * turn into one INSERT round-trip per ping.
 */
import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

const BATCH_SIZE = Number(process.env.INSERT_BATCH_SIZE ?? 200);
const FLUSH_MS = Number(process.env.INSERT_FLUSH_MS ?? 2000);

let buffer = [];
let flushTimer = null;

/**
 * Queue a position row: { time, mmsi, lat, lon, sog, cog, heading, corridor }
 */
export function queuePosition(row) {
  buffer.push(row);
  if (buffer.length >= BATCH_SIZE) {
    void flushPositions();
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => void flushPositions(), FLUSH_MS);
  }
}

export async function flushPositions() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0) return;

  const rows = buffer;
  buffer = [];

  const cols = 8;
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    const o = i * cols;
    values.push(
      `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8})`
    );
    params.push(r.time, r.mmsi, r.lat, r.lon, r.sog, r.cog, r.heading, r.corridor);
  });

  try {
    await pool.query(
      `INSERT INTO vessel_positions (time, mmsi, lat, lon, sog, cog, heading, corridor)
       VALUES ${values.join(',')}`,
      params
    );
  } catch (err) {
    // Drop the batch rather than let the buffer grow unbounded during a
    // db outage; raw positions are expendable (spec §9 backups).
    console.error(`[db] batch insert failed, dropped ${rows.length} rows:`, err.message);
  }
}

/**
 * Upsert vessel static data: { mmsi, name, shipType, shipTypeClass }
 */
export async function upsertVessel(v) {
  await pool.query(
    `INSERT INTO vessels (mmsi, name, ship_type, ship_type_class, last_seen)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (mmsi) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, vessels.name),
       ship_type = COALESCE(EXCLUDED.ship_type, vessels.ship_type),
       ship_type_class = COALESCE(EXCLUDED.ship_type_class, vessels.ship_type_class),
       last_seen = now()`,
    [v.mmsi, v.name ?? null, v.shipType ?? null, v.shipTypeClass ?? null]
  );
}

export async function shutdown() {
  await flushPositions();
  await pool.end();
}
