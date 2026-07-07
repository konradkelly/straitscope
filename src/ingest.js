/**
 * ingest.js — always-on AISStream.io websocket consumer.
 *
 * Responsibilities (and nothing more):
 *   1. Hold the websocket open, resubscribe on reconnect (exponential backoff).
 *   2. Classify each position into a corridor (cheap, at insert time).
 *   3. Batch-insert positions; upsert vessel static data.
 *   4. Track "last message at" for /healthz-style liveness (written to a file
 *      the api container can also read, or exposed via the worker).
 *
 * Transit detection deliberately does NOT live here — see worker.js.
 */
import WebSocket from 'ws';
import fs from 'node:fs';
import { REGIONS, findRegion, classifyCorridor, shipTypeClass, deriveFlag } from './geo.js';
import { queuePosition, upsertVessel, shutdown } from './db.js';

const API_KEY = process.env.AISSTREAM_API_KEY;
if (!API_KEY) {
  console.error('AISSTREAM_API_KEY is required');
  process.exit(1);
}

const STREAM_URL = 'wss://stream.aisstream.io/v0/stream';
const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE ?? '/tmp/ingest-last-message';

let backoffMs = 1000;
const BACKOFF_MAX = 60_000;
let stats = { positions: 0, statics: 0, ignored: 0 };

// Flag derivation needs only the MMSI, so it's cheap to backfill from a bare
// PositionReport rather than waiting on a ShipStaticData message that may
// never arrive. This set just avoids re-issuing the same upsert on every one
// of a vessel's many position reports within a process's lifetime — it
// resets on restart, which only costs a handful of harmless repeat upserts.
const flaggedMmsi = new Set();

function connect() {
  console.log('[ingest] connecting to AISStream…');
  const ws = new WebSocket(STREAM_URL);

  ws.on('open', () => {
    backoffMs = 1000;
    const boundingBoxes = Object.values(REGIONS).map((r) => r.roiBbox);
    ws.send(
      JSON.stringify({
        APIKey: API_KEY,
        BoundingBoxes: boundingBoxes,
        FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      })
    );
    console.log('[ingest] subscribed', { regions: Object.keys(REGIONS), boundingBoxes });
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    fs.writeFile(HEARTBEAT_FILE, String(Date.now()), () => {});

    const meta = msg.MetaData ?? {};
    const mmsi = Number(meta.MMSI);
    if (!Number.isFinite(mmsi)) return;

    if (msg.MessageType === 'PositionReport') {
      const p = msg.Message?.PositionReport;
      if (!p) return;

      const lat = Number(p.Latitude);
      const lon = Number(p.Longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

      // Regions' ROIs are disjoint bounding boxes within one shared
      // subscription (see connect() above) — figure out which one this
      // position belongs to, or drop it if it's outside all of them (e.g. a
      // stray match right at a bbox edge).
      const region = findRegion(lon, lat);
      if (!region) return;

      stats.positions++;
      queuePosition({
        time: meta.time_utc ? new Date(meta.time_utc) : new Date(),
        mmsi,
        lat,
        lon,
        sog: Number.isFinite(p.Sog) ? p.Sog : null,
        cog: Number.isFinite(p.Cog) ? p.Cog : null,
        heading: Number.isFinite(p.TrueHeading) && p.TrueHeading !== 511 ? p.TrueHeading : null,
        region,
        corridor: classifyCorridor(region, lon, lat),
      });

      if (!flaggedMmsi.has(mmsi)) {
        flaggedMmsi.add(mmsi);
        const flag = deriveFlag(mmsi);
        if (flag) {
          upsertVessel({ mmsi, flag }).catch((err) =>
            console.error('[ingest] flag upsert failed:', err.message)
          );
        }
      }
    } else if (msg.MessageType === 'ShipStaticData') {
      const s = msg.Message?.ShipStaticData;
      if (!s) return;

      stats.statics++;
      const type = Number(s.Type);
      upsertVessel({
        mmsi,
        name: (s.Name ?? meta.ShipName ?? '').trim() || null,
        shipType: Number.isFinite(type) ? type : null,
        shipTypeClass: Number.isFinite(type) ? shipTypeClass(type) : null,
        flag: deriveFlag(mmsi),
      }).catch((err) => console.error('[ingest] vessel upsert failed:', err.message));
    } else {
      stats.ignored++;
    }
  });

  const retry = (why) => {
    console.warn(`[ingest] ${why}; reconnecting in ${backoffMs} ms`);
    setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX);
  };

  ws.on('close', (code) => retry(`socket closed (${code})`));
  ws.on('error', (err) => {
    console.error('[ingest] socket error:', err.message);
    ws.terminate(); // 'close' fires and schedules the reconnect
  });
}

// Periodic stats line — cheap observability before real metrics exist.
setInterval(() => {
  console.log('[ingest] stats', { ...stats, at: new Date().toISOString() });
  stats = { positions: 0, statics: 0, ignored: 0 };
}, 60_000);

process.on('SIGTERM', async () => {
  console.log('[ingest] SIGTERM — flushing and exiting');
  await shutdown();
  process.exit(0);
});

connect();
