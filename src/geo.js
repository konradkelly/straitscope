/**
 * geo.js — region of interest, gate lines, corridor polygons, and the two
 * geometric primitives the whole product rests on: point-in-polygon and
 * segment intersection.
 *
 * ⚠ CALIBRATION REQUIRED: every coordinate below is an engineering
 * placeholder, eyeballed from a chart. Before launch, plot a few days of
 * real tracks (see tools/plot_tracks.sql idea in spec §6) and trace the
 * actual observed lanes. The route split is the product — get this right.
 *
 * Convention: all points are [lon, lat] (GeoJSON order).
 */

// Bounding box sent to AISStream: [[lat, lon], [lat, lon]] (their convention, SW → NE)
export const ROI_BBOX = [
  [25.0, 54.5],
  [27.8, 58.5],
];

// ---------------------------------------------------------------------------
// Gate lines (virtual tripwires). A transit = crossing both, in order.
// Each gate is a segment: [[lon, lat], [lon, lat]]
// ---------------------------------------------------------------------------
export const GATES = {
  // Persian Gulf side, west of the strait's narrowest point
  west: [
    [55.7, 26.55],
    [55.7, 25.9],
  ],
  // Gulf of Oman side, east of the strait
  east: [
    [57.1, 26.1],
    [57.1, 25.3],
  ],
};

// ---------------------------------------------------------------------------
// Corridor polygons (rough placeholders — CALIBRATE before launch)
// northern ≈ traditional TSS lanes / Iranian-waters routing
// southern ≈ Omani coastal corridor
// ---------------------------------------------------------------------------
export const CORRIDORS = {
  northern: [
    [55.7, 26.55],
    [56.3, 26.75],
    [56.9, 26.5],
    [57.1, 26.1],
    [57.1, 25.9],
    [56.8, 26.2],
    [56.25, 26.45],
    [55.7, 26.25],
  ],
  southern: [
    [55.7, 26.2],
    [56.2, 26.35],
    [56.7, 26.1],
    [57.1, 25.85],
    [57.1, 25.3],
    [56.6, 25.85],
    [56.1, 26.1],
    [55.7, 25.9],
  ],
};

/**
 * Ray-casting point-in-polygon. Fine at this scale (< 200 km, no pole/antimeridian).
 * @param {number} lon
 * @param {number} lat
 * @param {Array<[number, number]>} polygon - [lon, lat] vertices, unclosed ok
 * @returns {boolean}
 */
export function pointInPolygon(lon, lat, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Classify a position into a corridor.
 * @returns {'northern' | 'southern' | 'outside'}
 */
export function classifyCorridor(lon, lat) {
  if (pointInPolygon(lon, lat, CORRIDORS.northern)) return 'northern';
  if (pointInPolygon(lon, lat, CORRIDORS.southern)) return 'southern';
  return 'outside';
}

/**
 * 2-D segment intersection (orientation method). Geographic distortion over
 * a few km between consecutive AIS pings is irrelevant for tripwire detection.
 * Segments are [[lon, lat], [lon, lat]].
 */
export function segmentsIntersect(a, b) {
  const [p1, p2] = a;
  const [p3, p4] = b;

  const d = (p, q, r) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);

  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }

  const onSegment = (p, q, r) =>
    Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) &&
    Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);

  if (d1 === 0 && onSegment(p3, p4, p1)) return true;
  if (d2 === 0 && onSegment(p3, p4, p2)) return true;
  if (d3 === 0 && onSegment(p1, p2, p3)) return true;
  if (d4 === 0 && onSegment(p1, p2, p4)) return true;
  return false;
}

/**
 * Which gate (if any) does the movement p1 → p2 cross?
 * @param {[number, number]} p1 - [lon, lat]
 * @param {[number, number]} p2 - [lon, lat]
 * @returns {'west' | 'east' | null}
 */
export function crossedGate(p1, p2) {
  if (segmentsIntersect([p1, p2], GATES.west)) return 'west';
  if (segmentsIntersect([p1, p2], GATES.east)) return 'east';
  return null;
}

/**
 * Derive vessel class from AIS ship type code.
 * Tankers: 80–89. Cargo: 70–79. Everything else: other.
 */
export function shipTypeClass(code) {
  if (code >= 80 && code <= 89) return 'tanker';
  if (code >= 70 && code <= 79) return 'cargo';
  return 'other';
}
