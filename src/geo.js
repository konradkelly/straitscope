/**
 * geo.js — per-region config (ROI, gate lines, corridor polygons) plus the
 * geometric primitives the whole product rests on: point-in-polygon and
 * segment intersection.
 *
 * ⚠ CALIBRATION REQUIRED: every coordinate below is an engineering
 * placeholder, eyeballed from a chart. Before relying on a region's transit
 * counts, plot a few days of real tracks (see tools/export-tracks.js) and
 * trace the actual observed lanes.
 *
 * Convention: all points are [lon, lat] (GeoJSON order), except `roiBbox`
 * which follows AISStream's own [lat, lon] SW→NE convention (see ingest.js).
 */
import { MID_TO_FLAG } from './mid-codes.js';

// ---------------------------------------------------------------------------
// Region registry. Add a region by adding an entry here — ingest.js,
// worker.js, api.js, and the frontend all key off this one object.
//
// `corridors` is optional: a region with no named corridors (e.g. Singapore
// Strait, which has no Hormuz-style politically-distinct route split) gets
// `null`, and classifyCorridor/classifyRoute degrade to 'unclassified'
// rather than forcing a meaningless northern/southern label onto it.
//
// ⚠ Despite gate/corridor names nominally being free-form, worker.js's
// transit state machine hardcodes two of them: direction is
// `entered_gate === 'west' ? 'outbound' : 'inbound'`, and the per-transit
// route tally only counts positions where `corridor === 'northern'` or
// `'southern'` (see applyPosition/classifyRoute). A region that wants real
// direction/route-split output — not just a transit count — must name its
// gates `west`/`east` and its corridors `northern`/`southern`, regardless
// of their actual compass bearing.
// ---------------------------------------------------------------------------
export const REGIONS = {
  hormuz: {
    name: 'Strait of Hormuz',
    // Confirmed 2026-07-03/04 (spec.md §4.1.1): zero terrestrial AISStream
    // coverage over this ROI. Surfaced by the frontend so a zero-transit
    // dashboard here reads as a known data-source limitation, not a bug.
    coverageNote:
      'No AIS coverage: AISStream has zero terrestrial receivers near the Strait of Hormuz. ' +
      'Transit counts here are expected to stay at zero until a satellite AIS feed is integrated — see methodology.',
    // Persian Gulf approach, the strait itself, and the Gulf of Oman approach.
    roiBbox: [[25.0, 54.5], [27.8, 58.5]],
    gates: {
      // Persian Gulf side, west of the strait's narrowest point
      west: [[55.7, 26.55], [55.7, 25.9]],
      // Gulf of Oman side, east of the strait
      east: [[57.1, 26.1], [57.1, 25.3]],
    },
    corridors: {
      // northern ≈ traditional TSS lanes / Iranian-waters routing
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
      // southern ≈ Omani coastal corridor
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
    },
    routeThreshold: 0.7,
    mapCenter: [56.3, 26.3],
    mapZoom: 6.5,
  },

  singapore: {
    name: 'Singapore Strait',
    // Malacca Strait approach (west) through to the South China Sea approach (east).
    // Empirically confirmed to have live AISStream coverage (24 msgs/25s test,
    // vs. 0 for Hormuz) — see spec.md §4.1 for the full survey.
    roiBbox: [[1.0, 103.4], [1.5, 104.3]],
    gates: {
      // West gate: near Raffles Lighthouse, the Malacca Strait TSS transition.
      // Confirmed against 2026-07-05/06 live position data: this lon sits
      // right at the real density cliff (~1k positions/day just west of it,
      // ~8k+ just east), so it's already well-placed.
      west: [[103.75, 1.28], [103.75, 1.05]],
      // East gate: recalibrated 2026-07-06 from the original 104.10 (near
      // Horsburgh Lighthouse) after live data showed terrestrial AIS
      // coverage falls off a cliff past lon 104.00 (789 positions/36 vessels
      // in the 103.95-104.00 bucket vs. 92 in 104.00-104.05 and 2 total past
      // 104.10) — the old gate sat in a reception void where the "opposite
      // crossing" a transit needs was almost never observable. Moved to
      // 103.99, just inside the well-covered zone; lat range unchanged, it
      // already comfortably covers the observed p10-p90 traffic spread
      // (1.19-1.30) at this longitude.
      east: [[103.99, 1.35], [103.99, 1.15]],
    },
    // No politically-distinct route split here (unlike Hormuz's Iran/Oman
    // corridors) — leave unset until/unless a real product need for one
    // shows up.
    corridors: null,
    routeThreshold: null,
    mapCenter: [103.85, 1.2],
    mapZoom: 9.5,
  },

  dover: {
    name: 'Strait of Dover',
    // Confirmed live coverage 2026-07-06 (9 msgs/30s test; see spec.md
    // §4.1.1 addendum) — comparable to Singapore's launch survey.
    // ⚠ Placeholder ROI/gates/corridors, eyeballed from a chart — not yet
    // calibrated against real position density like Singapore's gates were.
    // English Channel approach (west/southwest), the Dover-Calais narrows,
    // and the North Sea approach (east/northeast).
    roiBbox: [[50.8, 1.0], [51.5, 2.3]],
    gates: {
      // Channel side, off Folkestone/Boulogne — west of the narrows.
      west: [[1.15, 51.1], [1.15, 50.85]],
      // North Sea side, off North Foreland/the Belgian coast — east of the narrows.
      east: [[2.05, 51.45], [2.05, 51.15]],
    },
    corridors: {
      // northern ≈ English-coast-side TSS lane (England sits north of the strait)
      northern: [
        [1.15, 51.1],
        [2.05, 51.45],
        [2.05, 51.3],
        [1.15, 50.98],
      ],
      // southern ≈ French/Belgian-coast-side TSS lane
      southern: [
        [1.15, 50.98],
        [2.05, 51.3],
        [2.05, 51.15],
        [1.15, 50.85],
      ],
    },
    routeThreshold: 0.7,
    mapCenter: [1.6, 51.05],
    mapZoom: 9,
  },
};

/**
 * Which region (if any) does this position fall inside? Regions' ROI boxes
 * are assumed disjoint, so first match wins.
 * @returns {string | null} region key, or null if outside every configured ROI
 */
export function findRegion(lon, lat) {
  for (const [key, region] of Object.entries(REGIONS)) {
    const [[latA, lonA], [latB, lonB]] = region.roiBbox;
    const minLat = Math.min(latA, latB);
    const maxLat = Math.max(latA, latB);
    const minLon = Math.min(lonA, lonB);
    const maxLon = Math.max(lonA, lonB);
    if (lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon) return key;
  }
  return null;
}

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
 * Classify a position into one of a region's named corridors.
 * @param {string} regionKey
 * @returns {string} corridor name, 'outside' (in the ROI but no named
 *   corridor), or 'unclassified' (region has no corridors defined at all)
 */
export function classifyCorridor(regionKey, lon, lat) {
  const corridors = REGIONS[regionKey]?.corridors;
  if (!corridors) return 'unclassified';
  for (const [name, polygon] of Object.entries(corridors)) {
    if (pointInPolygon(lon, lat, polygon)) return name;
  }
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
 * Which gate (if any) does the movement p1 → p2 cross, within a given region?
 * @param {string} regionKey
 * @param {[number, number]} p1 - [lon, lat]
 * @param {[number, number]} p2 - [lon, lat]
 * @returns {string | null} gate name (e.g. 'west' | 'east'), or null
 */
export function crossedGate(regionKey, p1, p2) {
  const gates = REGIONS[regionKey]?.gates;
  if (!gates) return null;
  for (const [name, line] of Object.entries(gates)) {
    if (segmentsIntersect([p1, p2], line)) return name;
  }
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

/**
 * Derive a vessel's flag state from its MMSI's Maritime Identification
 * Digits (first 3 of the standard 9-digit form) — see mid-codes.js. Unlike
 * ship_type_class, this needs no AIS message content beyond the MMSI
 * itself, so it can be (and is) derived from a plain PositionReport rather
 * than waiting on a ShipStaticData message that may never arrive.
 */
export function deriveFlag(mmsi) {
  const mid = Math.floor(Number(mmsi) / 1_000_000);
  return MID_TO_FLAG[mid] ?? null;
}
