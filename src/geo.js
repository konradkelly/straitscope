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
    // Corridors recalibrated 2026-07-09 against ~2 days of live production
    // data (71.7k positions/623 vessels): the original eyeballed polygons
    // traced a narrow "true TSS lane" width, which left 47% of positions
    // (56.5% before the sog/cog filtering used for calibration) classified
    // 'outside' either lane — starving classifyRoute's 70%-in-one-corridor
    // threshold and driving the 96.7% "mixed" route split seen in prod. Real
    // NE-bound (cog 20-70°, → North Sea) vs SW-bound (cog 200-250°, →
    // Channel) traffic does split cleanly by latitude (percentile_cont on
    // sog>3 positions in the 1.55-1.75°E and 1.85-2.00°E lon bands), so the
    // separator line below is data-derived from that crossover — but the
    // *outer* bounds are pushed out to the ROI edges rather than tracing a
    // realistic ~2nm lane width, because real traffic (including the
    // Dover/Calais anchorage clusters) spreads well beyond a true TSS lane
    // and a narrow polygon just recreates the 'outside' problem (verified:
    // narrow-lane redraw only got 'outside' to 24-38%, full-width split got
    // it to 15-17%). Net effect: 'northern'/'southern' now mean "which half
    // of the strait", same as the doc comment below already claimed, rather
    // than a precise lane trace. Gates unchanged (not recalibrated this
    // pass). See tools/export-tracks.js for the general recalibration process.
    // English Channel approach (west/southwest), the Dover-Calais narrows,
    // and the North Sea approach (east/northeast).
    roiBbox: [[50.8, 1.0], [51.5, 2.3]],
    gates: {
      // Channel side, off Folkestone/Boulogne — west of the narrows.
      // Recalibrated 2026-07-09: real moving traffic (sog>3) at this
      // longitude spans lat 50.83-51.49 (p10-p90), but the original gate
      // only reached 51.10 — missing everything north of it, which is most
      // of the lane. That's why outbound (enter west, exit east) transits
      // were showing up as exactly zero while inbound wasn't: crossings
      // into the strait via this gate were geometrically invisible for the
      // bulk of real traffic. Extended to just inside the ROI's own
      // northern edge (51.49) to match. See spec.md §6.1 addendum.
      west: [[1.15, 51.49], [1.15, 50.85]],
      // North Sea side, off North Foreland/the Belgian coast — east of the narrows.
      east: [[2.05, 51.45], [2.05, 51.15]],
    },
    corridors: {
      // northern ≈ English-coast-side half of the strait (England sits north)
      northern: [
        [1.15, 51.5],
        [2.05, 51.5],
        [2.05, 51.33],
        [1.65, 51.14],
        [1.15, 50.98],
      ],
      // southern ≈ French/Belgian-coast-side half of the strait
      southern: [
        [1.15, 50.98],
        [1.65, 51.14],
        [2.05, 51.33],
        [2.05, 50.8],
        [1.15, 50.8],
      ],
    },
    routeThreshold: 0.7,
    mapCenter: [1.6, 51.05],
    mapZoom: 9,
  },

  gibraltar: {
    name: 'Strait of Gibraltar',
    // Confirmed live coverage 2026-07-07 (12 msgs/90s Atlantic side, 14
    // msgs/90s Mediterranean side — both prospective gates checked
    // separately per spec.md §4.1.1's Malacca lesson). This re-test
    // contradicts the original 2026-07-03 survey's "marginal" 2 msgs/60s
    // finding — see spec.md §4.1.1 for the corrected entry.
    // ⚠ Gates are still a placeholder, eyeballed from a chart — not yet
    // calibrated against real position density.
    // Corridors recalibrated 2026-07-09 against ~2 days of live production
    // data (23.0k positions/394 vessels) — same method and same "outer
    // bounds pushed to the ROI edge, not a true TSS lane width" rationale as
    // Dover's recalibration above. Real eastbound (cog 60-100°, → Med) vs
    // westbound (cog 240-280°, → Atlantic) traffic splits cleanly by
    // latitude (percentile_cont on sog>3 positions in three lon bands
    // spanning the gates); that crossover is the separator line below.
    // Before: 27.6% of positions fell 'outside' either corridor. A
    // realistic-lane-width redraw made this *worse* (44.2%) because real
    // traffic disperses wider than a true lane; the full-width split got it
    // to 23.2%.
    // Atlantic approach (west), the Tarifa/Gibraltar narrows, and the
    // Mediterranean/Alboran Sea approach (east). Spain sits north of the
    // strait, Morocco south.
    roiBbox: [[35.75, -5.7], [36.15, -5.15]],
    gates: {
      // Atlantic side, off Tarifa/Tangier — west of the narrows.
      west: [[-5.65, 36.05], [-5.65, 35.78]],
      // Mediterranean side, off Gibraltar/Ceuta — east of the narrows.
      east: [[-5.25, 36.12], [-5.25, 35.85]],
    },
    corridors: {
      // northern ≈ Spanish-coast-side half of the strait (Spain sits north)
      northern: [
        [-5.65, 36.15],
        [-5.25, 36.15],
        [-5.25, 36.032],
        [-5.4, 35.99],
        [-5.65, 35.946],
      ],
      // southern ≈ Moroccan-coast-side half of the strait
      southern: [
        [-5.65, 35.946],
        [-5.4, 35.99],
        [-5.25, 36.032],
        [-5.25, 35.75],
        [-5.65, 35.75],
      ],
    },
    routeThreshold: 0.7,
    mapCenter: [-5.4, 35.95],
    mapZoom: 9.5,
  },

  oresund: {
    name: 'Öresund',
    // Confirmed live coverage 2026-07-07 (15 msgs/90s Helsingor/Helsingborg
    // narrows, 13 msgs/90s Copenhagen/Malmo narrows — both prospective
    // gates checked separately). Excellent, consistent with the original
    // 2026-07-03 survey (16 msgs/25s) — see spec.md §4.1.1.
    // ⚠ Placeholder ROI/gates — not yet calibrated against real position
    // density.
    // Runs north-south (Kattegat approach north, Baltic approach south),
    // unlike every other configured region's east-west axis — gate keys
    // are still 'west'/'east' per the worker.js convention (§6.2), so
    // 'west' here means the north gate and 'east' means the south gate;
    // 'outbound' therefore means Kattegat/North Sea → Baltic (southbound).
    roiBbox: [[55.4, 12.4], [56.2, 13.05]],
    gates: {
      // North gate: Helsingor (Denmark) / Helsingborg (Sweden) narrows,
      // the Kattegat approach — named 'west' per the worker.js convention.
      west: [[12.55, 56.1], [12.85, 56.1]],
      // South gate: Copenhagen (Denmark) / Malmo (Sweden) narrows, the
      // Baltic approach — named 'east' per the worker.js convention.
      east: [[12.55, 55.5], [12.95, 55.5]],
    },
    // The Sound does have two named channels (Drogden, near the Danish
    // side; Flinterrenden, near the Swedish side) but they're a
    // draft-based routing choice around the bridge/tunnel crossing near
    // the south gate, not a full-length directional lane split like
    // Hormuz's or Gibraltar's TSS corridors — forcing a northern/southern
    // label onto that would be the same product dishonesty called out for
    // Singapore. Leave unset until/unless a real product need shows up.
    corridors: null,
    routeThreshold: null,
    mapCenter: [12.7, 55.8],
    mapZoom: 8.5,
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
