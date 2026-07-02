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
import { ROI_BBOX, classifyCorridor, shipTypeClass } from './geo.js';
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

function connect() {
  console.log('[ingest] connecting to AISStream…');
  const ws = new WebSocket(STREAM_URL);

  ws.on('open', () => {
    backoffMs = 1000;
    ws.send(
      JSON.stringify({
        APIKey: API_KEY,
        BoundingBoxes: [ROI_BBOX],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      })
    );
    console.log('[ingest] subscribed', { roi: ROI_BBOX });
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

      stats.positions++;
      queuePosition({
        time: meta.time_utc ? new Date(meta.time_utc) : new Date(),
        mmsi,
        lat,
        lon,
        sog: Number.isFinite(p.Sog) ? p.Sog : null,
        cog: Number.isFinite(p.Cog) ? p.Cog : null,
        heading: Number.isFinite(p.TrueHeading) && p.TrueHeading !== 511 ? p.TrueHeading : null,
        corridor: classifyCorridor(lon, lat),
      });
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
