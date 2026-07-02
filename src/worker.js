/**
 * worker.js — transit detector. Runs every RUN_INTERVAL_MS, reads positions
 * since the persisted watermark, advances each vessel's state machine
 * (spec §6.2), records completed transits, refreshes daily_stats.
 *
 * Idempotency: positions are processed strictly by watermark; state lives in
 * transit_state, so a crash mid-pass replays at most one batch and upserts
 * converge to the same result.
 */
import { pool } from './db.js';
import { crossedGate } from './geo.js';

const RUN_INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 5 * 60_000);
const ABANDON_AFTER_H = Number(process.env.ABANDON_AFTER_HOURS ?? 48);
const ROUTE_THRESHOLD = 0.7; // spec §6.3

function classifyRoute(state) {
  const { northern_count: n, southern_count: s, total_count: t } = state;
  if (t === 0) return 'mixed';
  if (n / t >= ROUTE_THRESHOLD) return 'northern';
  if (s / t >= ROUTE_THRESHOLD) return 'southern';
  return 'mixed';
}

async function loadStates(client, mmsis) {
  if (mmsis.length === 0) return new Map();
  const { rows } = await client.query(
    'SELECT * FROM transit_state WHERE mmsi = ANY($1)',
    [mmsis]
  );
  return new Map(rows.map((r) => [Number(r.mmsi), r]));
}

function freshState(mmsi) {
  return {
    mmsi,
    state: 'IDLE',
    entered_gate: null,
    entered_at: null,
    last_lat: null,
    last_lon: null,
    last_time: null,
    northern_count: 0,
    southern_count: 0,
    total_count: 0,
  };
}

function resetToIdle(s) {
  s.state = 'IDLE';
  s.entered_gate = null;
  s.entered_at = null;
  s.northern_count = 0;
  s.southern_count = 0;
  s.total_count = 0;
}

async function pass() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const wm = await client.query('SELECT processed_to FROM worker_watermark WHERE id = 1 FOR UPDATE');
    const from = wm.rows[0].processed_to;
    // Leave a 2-minute lag so late-arriving batched inserts aren't skipped.
    const to = new Date(Date.now() - 2 * 60_000);
    if (to <= from) {
      await client.query('COMMIT');
      return;
    }

    const { rows: positions } = await client.query(
      `SELECT time, mmsi, lat, lon, corridor
       FROM vessel_positions
       WHERE time > $1 AND time <= $2
       ORDER BY mmsi, time`,
      [from, to]
    );

    const states = await loadStates(client, [...new Set(positions.map((p) => Number(p.mmsi)))]);
    const completed = [];

    for (const p of positions) {
      const mmsi = Number(p.mmsi);
      const s = states.get(mmsi) ?? freshState(mmsi);
      states.set(mmsi, s);

      // Abandon stale in-strait states (vessel dark or anchored, spec §6.2)
      if (
        s.state === 'IN_STRAIT' &&
        s.last_time &&
        p.time - new Date(s.last_time) > ABANDON_AFTER_H * 3600_000
      ) {
        resetToIdle(s);
      }

      const prev = s.last_lat != null ? [s.last_lon, s.last_lat] : null;
      const curr = [p.lon, p.lat];
      const gate = prev ? crossedGate(prev, curr) : null;

      if (s.state === 'IDLE' && gate) {
        s.state = 'IN_STRAIT';
        s.entered_gate = gate;
        s.entered_at = p.time;
        s.northern_count = 0;
        s.southern_count = 0;
        s.total_count = 0;
      } else if (s.state === 'IN_STRAIT' && gate) {
        if (gate !== s.entered_gate) {
          completed.push({
            mmsi,
            // entered west, exited east → heading into Gulf of Oman → outbound
            direction: s.entered_gate === 'west' ? 'outbound' : 'inbound',
            entered_at: s.entered_at,
            exited_at: p.time,
            route: classifyRoute(s),
            n_positions: s.total_count,
          });
        }
        // Either way (completed, or turned back through same gate) → IDLE
        resetToIdle(s);
      } else if (s.state === 'IN_STRAIT') {
        if (p.corridor === 'northern') s.northern_count++;
        else if (p.corridor === 'southern') s.southern_count++;
        s.total_count++;
      }

      s.last_lat = p.lat;
      s.last_lon = p.lon;
      s.last_time = p.time;
    }

    for (const t of completed) {
      await client.query(
        `INSERT INTO transits (mmsi, direction, entered_at, exited_at, route, n_positions)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [t.mmsi, t.direction, t.entered_at, t.exited_at, t.route, t.n_positions]
      );
    }

    for (const s of states.values()) {
      await client.query(
        `INSERT INTO transit_state
           (mmsi, state, entered_gate, entered_at, last_lat, last_lon, last_time,
            northern_count, southern_count, total_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (mmsi) DO UPDATE SET
           state = EXCLUDED.state,
           entered_gate = EXCLUDED.entered_gate,
           entered_at = EXCLUDED.entered_at,
           last_lat = EXCLUDED.last_lat,
           last_lon = EXCLUDED.last_lon,
           last_time = EXCLUDED.last_time,
           northern_count = EXCLUDED.northern_count,
           southern_count = EXCLUDED.southern_count,
           total_count = EXCLUDED.total_count`,
        [s.mmsi, s.state, s.entered_gate, s.entered_at, s.last_lat, s.last_lon,
         s.last_time, s.northern_count, s.southern_count, s.total_count]
      );
    }

    await client.query('UPDATE worker_watermark SET processed_to = $1 WHERE id = 1', [to]);
    await client.query('COMMIT');

    if (completed.length > 0) {
      await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY daily_stats');
    }

    console.log('[worker] pass complete', {
      positions: positions.length,
      transits: completed.length,
      watermark: to.toISOString(),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[worker] pass failed:', err);
  } finally {
    client.release();
  }
}

console.log(`[worker] starting, interval ${RUN_INTERVAL_MS} ms`);
await pass();
setInterval(pass, RUN_INTERVAL_MS);
