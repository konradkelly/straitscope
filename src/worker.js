/**
 * worker.js — transit detector. Runs every RUN_INTERVAL_MS, reads positions
 * since the persisted watermark, advances each vessel's state machine
 * (spec §6.2), records completed transits, flags dark vessels (spec §6.4),
 * refreshes daily_stats.
 *
 * Idempotency: positions are processed strictly by watermark; state lives in
 * transit_state, so a crash mid-pass replays at most one batch and upserts
 * converge to the same result.
 *
 * State transitions (applyPosition, checkStaleness) are pure functions with
 * no db dependency, so the state machine can be unit tested directly — see
 * test/worker.test.js.
 */
import { pathToFileURL } from 'node:url';
import { pool } from './db.js';
import { REGIONS, crossedGate } from './geo.js';

const RUN_INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 5 * 60_000);
const ABANDON_AFTER_H = Number(process.env.ABANDON_AFTER_HOURS ?? 48);
const DARK_AFTER_H = Number(process.env.DARK_AFTER_HOURS ?? 6);
// A real strait crossing takes hours, not days. A vessel that has been
// IN_STRAIT this long is virtually never still transiting — it's anchored or
// calling at a port inside the ROI (e.g. Algeciras Bay, Singapore's
// anchorages) and will likely never reach the opposite gate. ABANDON_AFTER_H
// alone never catches these because they keep transmitting positions (just
// not toward a gate), so they'd otherwise sit in transit_state forever.
const MAX_IN_STRAIT_H = Number(process.env.MAX_IN_STRAIT_HOURS ?? 72);

/**
 * Classify a completed transit's route within its region. Regions without
 * named corridors (e.g. singapore) always come back 'unclassified' — see
 * src/geo.js REGIONS.
 */
export function classifyRoute(region, state) {
  const corridors = REGIONS[region]?.corridors;
  if (!corridors) return 'unclassified';
  const threshold = REGIONS[region].routeThreshold;
  const { northern_count: n, southern_count: s, total_count: t } = state;
  if (t === 0) return 'mixed';
  if (n / t >= threshold) return 'northern';
  if (s / t >= threshold) return 'southern';
  return 'mixed';
}

export function freshState(region, mmsi) {
  return {
    region,
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
    last_sog: null,
    dark_flagged: false,
  };
}

function resetToIdle(s) {
  s.state = 'IDLE';
  s.entered_gate = null;
  s.entered_at = null;
  s.northern_count = 0;
  s.southern_count = 0;
  s.total_count = 0;
  s.dark_flagged = false;
}

/**
 * Advance one vessel's state machine by one incoming position (spec §6.2).
 * Pure — does not mutate `state`, returns the next state plus a completed
 * transit record if this position closed one out.
 * @param {object} state - a transit_state row shape (see freshState)
 * @param {{time: Date, lat: number, lon: number, sog: number|null, region: string, corridor: string}} position
 * @returns {{state: object, transit: object|null}}
 */
export function applyPosition(state, position) {
  const s = { ...state };
  let transit = null;

  const prev = s.last_lat != null ? [s.last_lon, s.last_lat] : null;
  const curr = [position.lon, position.lat];
  const gate = prev ? crossedGate(position.region, prev, curr) : null;

  if (s.state === 'IDLE' && gate) {
    s.state = 'IN_STRAIT';
    s.entered_gate = gate;
    s.entered_at = position.time;
    s.northern_count = 0;
    s.southern_count = 0;
    s.total_count = 0;
  } else if (s.state === 'IN_STRAIT' && gate) {
    if (gate !== s.entered_gate) {
      // entered west, exited east → heading into Gulf of Oman → outbound
      transit = {
        direction: s.entered_gate === 'west' ? 'outbound' : 'inbound',
        entered_at: s.entered_at,
        exited_at: position.time,
        route: classifyRoute(position.region, s),
        n_positions: s.total_count,
      };
    }
    // Either way (completed, or turned back through same gate) → IDLE
    resetToIdle(s);
  } else if (s.state === 'IN_STRAIT') {
    if (position.corridor === 'northern') s.northern_count++;
    else if (position.corridor === 'southern') s.southern_count++;
    s.total_count++;
  }

  s.last_lat = position.lat;
  s.last_lon = position.lon;
  s.last_time = position.time;
  s.last_sog = position.sog;
  s.dark_flagged = false; // a fresh position means it's no longer silently dark

  return { state: s, transit };
}

/**
 * Decide whether an IN_STRAIT vessel that produced no new positions this
 * pass should be abandoned (spec §6.2) or flagged dark (spec §6.4), based on
 * wall-clock silence since its last known position — or abandoned regardless
 * of silence if it's been IN_STRAIT far longer than any real transit takes
 * (spec §6.1 addendum: anchorage/port-calling traffic, not a detector bug).
 * @param {{last_time: Date, last_sog: number|null, dark_flagged: boolean, entered_at: Date|null}} row
 * @param {Date} now
 * @param {{abandonAfterH: number, darkAfterH: number, maxInStraitH?: number}} thresholds
 * @returns {{abandon: boolean, dark: boolean}}
 */
export function checkStaleness(row, now, { abandonAfterH, darkAfterH, maxInStraitH }) {
  const silentMs = now - new Date(row.last_time);
  if (silentMs > abandonAfterH * 3600_000) {
    return { abandon: true, dark: false };
  }
  if (maxInStraitH != null && row.entered_at != null) {
    const inStraitMs = now - new Date(row.entered_at);
    if (inStraitMs > maxInStraitH * 3600_000) {
      return { abandon: true, dark: false };
    }
  }
  if (!row.dark_flagged && row.last_sog > 1 && silentMs > darkAfterH * 3600_000) {
    return { abandon: false, dark: true };
  }
  return { abandon: false, dark: false };
}

const stateKey = (region, mmsi) => `${region}:${mmsi}`;

async function loadStates(client, pairs) {
  if (pairs.length === 0) return new Map();
  const { rows } = await client.query(
    `SELECT * FROM transit_state
     WHERE (region, mmsi) IN (SELECT * FROM UNNEST($1::text[], $2::bigint[]))`,
    [pairs.map((p) => p.region), pairs.map((p) => p.mmsi)]
  );
  return new Map(rows.map((r) => [stateKey(r.region, Number(r.mmsi)), r]));
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
      `SELECT time, mmsi, lat, lon, sog, region, corridor
       FROM vessel_positions
       WHERE time > $1 AND time <= $2
       ORDER BY region, mmsi, time`,
      [from, to]
    );

    const pairs = [...new Map(
      positions.map((p) => [stateKey(p.region, Number(p.mmsi)), { region: p.region, mmsi: Number(p.mmsi) }])
    ).values()];
    const states = await loadStates(client, pairs);
    const completed = [];

    for (const p of positions) {
      const mmsi = Number(p.mmsi);
      const key = stateKey(p.region, mmsi);
      const prevState = states.get(key) ?? freshState(p.region, mmsi);
      const { state: nextState, transit } = applyPosition(prevState, p);
      nextState.region = p.region;
      nextState.mmsi = mmsi;
      states.set(key, nextState);
      if (transit) completed.push({ mmsi, region: p.region, ...transit });
    }

    for (const t of completed) {
      await client.query(
        `INSERT INTO transits (mmsi, region, direction, entered_at, exited_at, route, n_positions)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [t.mmsi, t.region, t.direction, t.entered_at, t.exited_at, t.route, t.n_positions]
      );
    }

    for (const s of states.values()) {
      await client.query(
        `INSERT INTO transit_state
           (region, mmsi, state, entered_gate, entered_at, last_lat, last_lon, last_time,
            northern_count, southern_count, total_count, last_sog, dark_flagged)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (region, mmsi) DO UPDATE SET
           state = EXCLUDED.state,
           entered_gate = EXCLUDED.entered_gate,
           entered_at = EXCLUDED.entered_at,
           last_lat = EXCLUDED.last_lat,
           last_lon = EXCLUDED.last_lon,
           last_time = EXCLUDED.last_time,
           northern_count = EXCLUDED.northern_count,
           southern_count = EXCLUDED.southern_count,
           total_count = EXCLUDED.total_count,
           last_sog = EXCLUDED.last_sog,
           dark_flagged = EXCLUDED.dark_flagged`,
        [s.region, s.mmsi, s.state, s.entered_gate, s.entered_at, s.last_lat, s.last_lon,
         s.last_time, s.northern_count, s.southern_count, s.total_count,
         s.last_sog, s.dark_flagged]
      );
    }

    // Sweep ALL in-strait vessels (not just ones with new positions this
    // pass) for wall-clock silence — this is the only way to catch a vessel
    // that has gone permanently quiet and will never produce another
    // position to trigger the per-position checks above.
    const { rows: staleRows } = await client.query(
      `SELECT region, mmsi, last_time, last_sog, dark_flagged, entered_at FROM transit_state
       WHERE state = 'IN_STRAIT' AND last_time IS NOT NULL AND last_time <= $1`,
      [to]
    );
    let newlyDark = 0;
    for (const row of staleRows) {
      const { abandon, dark } = checkStaleness(row, to, {
        abandonAfterH: ABANDON_AFTER_H,
        darkAfterH: DARK_AFTER_H,
        maxInStraitH: MAX_IN_STRAIT_H,
      });
      if (abandon) {
        await client.query(
          `UPDATE transit_state SET state='IDLE', entered_gate=NULL, entered_at=NULL,
             northern_count=0, southern_count=0, total_count=0, dark_flagged=false
           WHERE region = $1 AND mmsi = $2`,
          [row.region, row.mmsi]
        );
      } else if (dark) {
        newlyDark++;
        await client.query(
          'UPDATE transit_state SET dark_flagged = true WHERE region = $1 AND mmsi = $2',
          [row.region, row.mmsi]
        );
        await client.query(
          'INSERT INTO dark_events (mmsi, region, last_seen_at) VALUES ($1, $2, $3)',
          [row.mmsi, row.region, row.last_time]
        );
      }
    }

    await client.query('UPDATE worker_watermark SET processed_to = $1 WHERE id = 1', [to]);
    await client.query('COMMIT');

    if (completed.length > 0) {
      try {
        await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY daily_stats');
      } catch {
        // First-ever refresh: the view is created WITH NO DATA, and
        // CONCURRENTLY requires existing data to diff against.
        await client.query('REFRESH MATERIALIZED VIEW daily_stats');
      }
    }

    console.log('[worker] pass complete', {
      positions: positions.length,
      transits: completed.length,
      newlyDark,
      watermark: to.toISOString(),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[worker] pass failed:', err);
  } finally {
    client.release();
  }
}

// Only run the loop when executed directly (`node src/worker.js`), not when
// imported by tests.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  console.log(`[worker] starting, interval ${RUN_INTERVAL_MS} ms`);
  await pass();
  setInterval(pass, RUN_INTERVAL_MS);
}
