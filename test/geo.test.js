import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pointInPolygon,
  classifyCorridor,
  segmentsIntersect,
  crossedGate,
  findRegion,
  shipTypeClass,
  REGIONS,
} from '../src/geo.js';

test('pointInPolygon: unit square', () => {
  const square = [[0, 0], [1, 0], [1, 1], [0, 1]];
  assert.equal(pointInPolygon(0.5, 0.5, square), true);
  assert.equal(pointInPolygon(1.5, 0.5, square), false);
  assert.equal(pointInPolygon(-0.1, 0.5, square), false);
});

test('findRegion: point inside hormuz ROI', () => {
  assert.equal(findRegion(56.3, 26.55), 'hormuz');
});

test('findRegion: point inside singapore ROI', () => {
  assert.equal(findRegion(103.9, 1.2), 'singapore');
});

test('findRegion: point outside every ROI', () => {
  assert.equal(findRegion(0, 0), null);
});

test('classifyCorridor: mid-channel northern lane point (hormuz)', () => {
  // Roughly inside the placeholder northern polygon
  assert.equal(classifyCorridor('hormuz', 56.3, 26.55), 'northern');
});

test('classifyCorridor: point on land / far outside (hormuz)', () => {
  assert.equal(classifyCorridor('hormuz', 54.0, 24.0), 'outside');
});

test('classifyCorridor: region with no corridors defined is always unclassified (singapore)', () => {
  assert.equal(classifyCorridor('singapore', 103.9, 1.2), 'unclassified');
});

test('segmentsIntersect: crossing X', () => {
  assert.equal(
    segmentsIntersect([[0, 0], [1, 1]], [[0, 1], [1, 0]]),
    true
  );
});

test('segmentsIntersect: parallel non-touching', () => {
  assert.equal(
    segmentsIntersect([[0, 0], [1, 0]], [[0, 1], [1, 1]]),
    false
  );
});

test('crossedGate: eastward movement through hormuz west gate', () => {
  // West gate is a vertical segment at lon 55.7 between lat 25.9 and 26.55
  const before = [55.6, 26.2];
  const after = [55.8, 26.2];
  assert.equal(crossedGate('hormuz', before, after), 'west');
});

test('crossedGate: movement north of the gate does not trip it (hormuz)', () => {
  const before = [55.6, 27.0];
  const after = [55.8, 27.0];
  assert.equal(crossedGate('hormuz', before, after), null);
});

test('crossedGate: eastward movement through hormuz east gate', () => {
  const before = [57.0, 25.7];
  const after = [57.2, 25.7];
  assert.equal(crossedGate('hormuz', before, after), 'east');
});

test('crossedGate: eastward movement through singapore west gate', () => {
  // West gate is a vertical segment at lon 103.75 between lat 1.05 and 1.28
  const before = [103.7, 1.2];
  const after = [103.8, 1.2];
  assert.equal(crossedGate('singapore', before, after), 'west');
});

test('crossedGate: eastward movement through singapore east gate', () => {
  // East gate is a vertical segment at lon 103.99 between lat 1.15 and 1.35
  const before = [103.94, 1.25];
  const after = [104.04, 1.25];
  assert.equal(crossedGate('singapore', before, after), 'east');
});

test('crossedGate: a hormuz-region crossing does not trip a singapore gate', () => {
  const before = [55.6, 26.2];
  const after = [55.8, 26.2];
  assert.equal(crossedGate('singapore', before, after), null);
});

test('shipTypeClass mapping', () => {
  assert.equal(shipTypeClass(84), 'tanker');
  assert.equal(shipTypeClass(70), 'cargo');
  assert.equal(shipTypeClass(30), 'other');
});

test('gates are inside plausible ROI bounds, for every region', () => {
  for (const region of Object.values(REGIONS)) {
    const [[latA, lonA], [latB, lonB]] = region.roiBbox;
    const minLat = Math.min(latA, latB);
    const maxLat = Math.max(latA, latB);
    const minLon = Math.min(lonA, lonB);
    const maxLon = Math.max(lonA, lonB);
    for (const gate of Object.values(region.gates)) {
      for (const [lon, lat] of gate) {
        assert.ok(lon > minLon && lon < maxLon, `lon ${lon} in ROI`);
        assert.ok(lat > minLat && lat < maxLat, `lat ${lat} in ROI`);
      }
    }
  }
});
