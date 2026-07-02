import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pointInPolygon,
  classifyCorridor,
  segmentsIntersect,
  crossedGate,
  shipTypeClass,
  GATES,
} from '../src/geo.js';

test('pointInPolygon: unit square', () => {
  const square = [[0, 0], [1, 0], [1, 1], [0, 1]];
  assert.equal(pointInPolygon(0.5, 0.5, square), true);
  assert.equal(pointInPolygon(1.5, 0.5, square), false);
  assert.equal(pointInPolygon(-0.1, 0.5, square), false);
});

test('classifyCorridor: mid-channel northern lane point', () => {
  // Roughly inside the placeholder northern polygon
  assert.equal(classifyCorridor(56.3, 26.55), 'northern');
});

test('classifyCorridor: point on land / far outside', () => {
  assert.equal(classifyCorridor(54.0, 24.0), 'outside');
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

test('crossedGate: eastward movement through west gate', () => {
  // West gate is a vertical segment at lon 55.7 between lat 25.9 and 26.55
  const before = [55.6, 26.2];
  const after = [55.8, 26.2];
  assert.equal(crossedGate(before, after), 'west');
});

test('crossedGate: movement north of the gate does not trip it', () => {
  const before = [55.6, 27.0];
  const after = [55.8, 27.0];
  assert.equal(crossedGate(before, after), null);
});

test('crossedGate: eastward movement through east gate', () => {
  const before = [57.0, 25.7];
  const after = [57.2, 25.7];
  assert.equal(crossedGate(before, after), 'east');
});

test('shipTypeClass mapping', () => {
  assert.equal(shipTypeClass(84), 'tanker');
  assert.equal(shipTypeClass(70), 'cargo');
  assert.equal(shipTypeClass(30), 'other');
});

test('gates are inside plausible strait bounds', () => {
  for (const gate of Object.values(GATES)) {
    for (const [lon, lat] of gate) {
      assert.ok(lon > 54.5 && lon < 58.5, `lon ${lon} in ROI`);
      assert.ok(lat > 25.0 && lat < 27.8, `lat ${lat} in ROI`);
    }
  }
});
