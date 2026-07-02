/**
 * export-tracks.js — dump recent vessel positions as GeoJSON, for
 * calibrating the gate lines and corridor polygons in src/geo.js (spec §6).
 *
 * Usage:
 *   node --env-file=.env tools/export-tracks.js [days] [tracks|points] > out.geojson
 *
 * Paste out.geojson into https://geojson.io to see where vessels actually
 * travel, then redraw GATES / CORRIDORS in src/geo.js to match.
 *
 *   tracks (default) — one LineString per vessel, connecting its positions
 *                       in order. Good for tracing the two lanes.
 *   points            — every raw position as its own Point. Good for
 *                       seeing coverage density without connect-the-dots
 *                       artifacts across coverage gaps.
 */
import { pool } from '../src/db.js';

const days = Number(process.argv[2] ?? 3);
const mode = process.argv[3] === 'points' ? 'points' : 'tracks';

const { rows } = await pool.query(
  `SELECT mmsi, time, lat, lon, corridor
   FROM vessel_positions
   WHERE time > now() - ($1 || ' days')::interval
   ORDER BY mmsi, time`,
  [days]
);

let features;
if (mode === 'points') {
  features = rows.map((r) => ({
    type: 'Feature',
    properties: { mmsi: String(r.mmsi), corridor: r.corridor },
    geometry: { type: 'Point', coordinates: [Number(r.lon), Number(r.lat)] },
  }));
} else {
  const byMmsi = new Map();
  for (const r of rows) {
    const list = byMmsi.get(r.mmsi) ?? [];
    list.push(r);
    byMmsi.set(r.mmsi, list);
  }
  features = [...byMmsi.entries()]
    .filter(([, points]) => points.length >= 2)
    .map(([mmsi, points]) => ({
      type: 'Feature',
      properties: { mmsi: String(mmsi), points: points.length },
      geometry: { type: 'LineString', coordinates: points.map((p) => [Number(p.lon), Number(p.lat)]) },
    }));
}

process.stdout.write(JSON.stringify({ type: 'FeatureCollection', features }));
await pool.end();
console.error(`[export-tracks] wrote ${features.length} ${mode} feature(s) from ${rows.length} position(s) (last ${days}d)`);
