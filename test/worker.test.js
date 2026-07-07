import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPosition, checkStaleness, classifyRoute, freshState } from '../src/worker.js';

// Hormuz: west gate lon 55.7, lat 25.9–26.55. East gate lon 57.1, lat 25.3–26.1.
// Singapore: west gate lon 103.75, lat 1.05–1.28. East gate lon 103.99, lat 1.15–1.35.
// (see src/geo.js REGIONS)
const westCrossing = (fromLon, toLon, lat = 26.2) => [
  { lon: fromLon, lat },
  { lon: toLon, lat },
];
const eastCrossing = (fromLon, toLon, lat = 25.7) => [
  { lon: fromLon, lat },
  { lon: toLon, lat },
];

function feed(state, region, points) {
  let s = state;
  let lastResult = { state: s, transit: null };
  for (const p of points) {
    lastResult = applyPosition(s, {
      time: new Date(p.time ?? Date.now()),
      lat: p.lat,
      lon: p.lon,
      sog: p.sog ?? 10,
      region,
      corridor: p.corridor ?? 'outside',
    });
    s = lastResult.state;
  }
  return lastResult;
}

test('IDLE + no gate crossing stays IDLE and just tracks position', () => {
  const s = freshState('hormuz', 1);
  const { state, transit } = applyPosition(s, { time: new Date(), lat: 27.0, lon: 55.6, sog: 5, region: 'hormuz', corridor: 'outside' });
  assert.equal(state.state, 'IDLE');
  assert.equal(transit, null);
  assert.equal(state.last_lat, 27.0);
});

test('IDLE -> IN_STRAIT on west gate crossing', () => {
  const s = freshState('hormuz', 1);
  const [p1, p2] = westCrossing(55.6, 55.8);
  const withPos1 = applyPosition(s, { time: new Date(1000), ...p1, sog: 10, region: 'hormuz', corridor: 'outside' }).state;
  const { state, transit } = applyPosition(withPos1, { time: new Date(2000), ...p2, sog: 10, region: 'hormuz', corridor: 'outside' });
  assert.equal(state.state, 'IN_STRAIT');
  assert.equal(state.entered_gate, 'west');
  assert.equal(transit, null);
});

test('full outbound transit: enter west, exit east -> outbound (hormuz, route classified)', () => {
  const s = freshState('hormuz', 1);
  const t0 = Date.now();
  const points = [
    { time: t0, ...westCrossing(55.6, 55.8)[0] },
    { time: t0 + 1000, ...westCrossing(55.6, 55.8)[1], corridor: 'northern' },
    { time: t0 + 2000, lat: 26.0, lon: 56.5, corridor: 'northern' },
    { time: t0 + 3000, ...eastCrossing(57.0, 57.2)[0], corridor: 'northern' },
    { time: t0 + 4000, ...eastCrossing(57.0, 57.2)[1] },
  ];
  const { state, transit } = feed(s, 'hormuz', points);
  assert.equal(state.state, 'IDLE');
  assert.ok(transit);
  assert.equal(transit.direction, 'outbound');
  assert.equal(transit.route, 'northern');
});

test('full inbound transit: enter east, exit west -> inbound (hormuz, route classified)', () => {
  const s = freshState('hormuz', 1);
  const t0 = Date.now();
  const points = [
    { time: t0, ...eastCrossing(57.2, 57.0)[0] },
    { time: t0 + 1000, ...eastCrossing(57.2, 57.0)[1], corridor: 'southern' },
    { time: t0 + 2000, lat: 25.95, lon: 56.4, corridor: 'southern' },
    { time: t0 + 3000, ...westCrossing(55.8, 55.6)[0], corridor: 'southern' },
    { time: t0 + 4000, ...westCrossing(55.8, 55.6)[1] },
  ];
  const { state, transit } = feed(s, 'hormuz', points);
  assert.equal(state.state, 'IDLE');
  assert.ok(transit);
  assert.equal(transit.direction, 'inbound');
  assert.equal(transit.route, 'southern');
});

test('full transit in a region with no corridors comes back unclassified (singapore)', () => {
  const s = freshState('singapore', 2);
  const t0 = Date.now();
  const points = [
    { time: t0, lon: 103.70, lat: 1.2 },
    { time: t0 + 1000, lon: 103.80, lat: 1.2 },
    { time: t0 + 2000, lon: 103.94, lat: 1.2 },
    { time: t0 + 3000, lon: 103.97, lat: 1.25 },
    { time: t0 + 4000, lon: 104.04, lat: 1.25 },
  ];
  const { state, transit } = feed(s, 'singapore', points);
  assert.equal(state.state, 'IDLE');
  assert.ok(transit);
  assert.equal(transit.direction, 'outbound');
  assert.equal(transit.route, 'unclassified');
});

test('turning back through the same gate resets to IDLE without a transit', () => {
  const s = freshState('hormuz', 1);
  const t0 = Date.now();
  const points = [
    { time: t0, ...westCrossing(55.6, 55.8)[0] },
    { time: t0 + 1000, ...westCrossing(55.6, 55.8)[1] },
    { time: t0 + 2000, ...westCrossing(55.8, 55.6)[0] },
    { time: t0 + 3000, ...westCrossing(55.8, 55.6)[1] },
  ];
  const { state, transit } = feed(s, 'hormuz', points);
  assert.equal(state.state, 'IDLE');
  assert.equal(transit, null);
});

test('a fresh position always clears dark_flagged', () => {
  const s = { ...freshState('hormuz', 1), state: 'IN_STRAIT', dark_flagged: true, last_lat: 26.2, last_lon: 56.0 };
  const { state } = applyPosition(s, { time: new Date(), lat: 26.2, lon: 56.1, sog: 5, region: 'hormuz', corridor: 'northern' });
  assert.equal(state.dark_flagged, false);
});

test('classifyRoute: northern >= 70% threshold (hormuz)', () => {
  assert.equal(classifyRoute('hormuz', { northern_count: 8, southern_count: 1, total_count: 10 }), 'northern');
});

test('classifyRoute: southern >= 70% threshold (hormuz)', () => {
  assert.equal(classifyRoute('hormuz', { northern_count: 1, southern_count: 8, total_count: 10 }), 'southern');
});

test('classifyRoute: below threshold on both sides is mixed (hormuz)', () => {
  assert.equal(classifyRoute('hormuz', { northern_count: 5, southern_count: 4, total_count: 10 }), 'mixed');
});

test('classifyRoute: zero positions is mixed (hormuz)', () => {
  assert.equal(classifyRoute('hormuz', { northern_count: 0, southern_count: 0, total_count: 0 }), 'mixed');
});

test('classifyRoute: a region with no corridors is always unclassified regardless of counts (singapore)', () => {
  assert.equal(classifyRoute('singapore', { northern_count: 8, southern_count: 1, total_count: 10 }), 'unclassified');
});

test('checkStaleness: within thresholds is neither abandoned nor dark', () => {
  const now = new Date('2026-07-02T12:00:00Z');
  const row = { last_time: new Date('2026-07-02T11:00:00Z'), last_sog: 10, dark_flagged: false };
  assert.deepEqual(
    checkStaleness(row, now, { abandonAfterH: 48, darkAfterH: 6 }),
    { abandon: false, dark: false }
  );
});

test('checkStaleness: silent > 6h while moving flags dark', () => {
  const now = new Date('2026-07-02T12:00:00Z');
  const row = { last_time: new Date('2026-07-02T05:00:00Z'), last_sog: 12, dark_flagged: false };
  assert.deepEqual(
    checkStaleness(row, now, { abandonAfterH: 48, darkAfterH: 6 }),
    { abandon: false, dark: true }
  );
});

test('checkStaleness: silent > 6h but not moving (sog <= 1) does not flag dark', () => {
  const now = new Date('2026-07-02T12:00:00Z');
  const row = { last_time: new Date('2026-07-02T05:00:00Z'), last_sog: 0.2, dark_flagged: false };
  assert.deepEqual(
    checkStaleness(row, now, { abandonAfterH: 48, darkAfterH: 6 }),
    { abandon: false, dark: false }
  );
});

test('checkStaleness: already flagged dark is not re-flagged', () => {
  const now = new Date('2026-07-02T12:00:00Z');
  const row = { last_time: new Date('2026-07-02T05:00:00Z'), last_sog: 12, dark_flagged: true };
  assert.deepEqual(
    checkStaleness(row, now, { abandonAfterH: 48, darkAfterH: 6 }),
    { abandon: false, dark: false }
  );
});

test('checkStaleness: silent past abandon threshold takes priority over dark', () => {
  const now = new Date('2026-07-03T12:00:00Z');
  const row = { last_time: new Date('2026-07-01T05:00:00Z'), last_sog: 12, dark_flagged: false };
  assert.deepEqual(
    checkStaleness(row, now, { abandonAfterH: 48, darkAfterH: 6 }),
    { abandon: true, dark: false }
  );
});
