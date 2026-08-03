/**
 * Geodesy tests. Run with: node web/test/geo.test.mjs
 *
 * These matter more than they look: distance and bearing are what someone
 * reads while walking toward a dog, and a sign error in the arrow sends them
 * the wrong way with no obvious signal that anything is wrong.
 */

import assert from 'node:assert/strict';
import { distance, bearing, relativeBearing, compass, formatDistance, freshness } from '../js/geo.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ok  ' + name);
    passed++;
  } catch (err) {
    console.error('FAIL  ' + name + '\n      ' + err.message);
    process.exitCode = 1;
  }
}

const near = (a, b, tol, what) =>
  assert.ok(Math.abs(a - b) < tol, `${what}: expected ~${b}, got ${a}`);

console.log('distance');

test('one degree of latitude is ~111.2 km', () => {
  near(distance(0, 0, 1, 0), 111195, 200, 'distance');
});

test('one degree of longitude at the equator is ~111.2 km', () => {
  near(distance(0, 0, 0, 1), 111195, 200, 'distance');
});

test('longitude degrees shrink with latitude', () => {
  // At 60 degrees north a degree of longitude is about half its equator width.
  near(distance(60, 0, 60, 1), 111195 / 2, 600, 'distance');
});

test('London to Paris is ~343 km', () => {
  near(distance(51.5074, -0.1278, 48.8566, 2.3522), 343500, 3000, 'distance');
});

test('zero distance to itself', () => {
  assert.equal(distance(33.5, -101.9, 33.5, -101.9), 0);
});

console.log('bearing');

test('due north is 0', () => near(bearing(0, 0, 1, 0), 0, 0.01, 'bearing'));
test('due east is 90', () => near(bearing(0, 0, 0, 1), 90, 0.01, 'bearing'));
test('due south is 180', () => near(bearing(0, 0, -1, 0), 180, 0.01, 'bearing'));
test('due west is 270', () => near(bearing(0, 0, 0, -1), 270, 0.01, 'bearing'));

test('London to Paris is roughly south-east', () => {
  // 148.12 deg, verified independently. Note this is the INITIAL bearing; the
  // bearing on arrival is 150.02, because a great circle curves. Sources
  // quoting ~156 are using different endpoints.
  const b = bearing(51.5074, -0.1278, 48.8566, 2.3522);
  near(b, 148.12, 0.05, 'bearing');
  assert.equal(compass(b), 'SSE');
});

test('always returns 0-360, never negative', () => {
  for (const [a, b, c, d] of [[0,0,-1,-1],[10,170,-10,-170],[45,-120,-45,120]]) {
    const x = bearing(a, b, c, d);
    assert.ok(x >= 0 && x < 360, `bearing out of range: ${x}`);
  }
});

console.log('relative bearing (the arrow)');

test('target ahead when heading matches bearing', () => {
  assert.equal(relativeBearing(90, 90), 0);
});

test('target behind when facing away', () => {
  assert.equal(relativeBearing(0, 180), 180);
});

test('target to the right when facing north and target east', () => {
  assert.equal(relativeBearing(90, 0), 90);
});

test('target to the left when facing east and target north', () => {
  assert.equal(relativeBearing(0, 90), 270);
});

test('wraps rather than going negative', () => {
  assert.equal(relativeBearing(10, 350), 20);
  assert.equal(relativeBearing(350, 10), 340);
});

console.log('formatting');

test('short distances are yards, long are miles', () => {
  assert.match(formatDistance(100), /yd$/);
  assert.match(formatDistance(5000), /mi$/);
});

test('metric when asked', () => {
  assert.equal(formatDistance(500, 'metric'), '500 m');
  assert.equal(formatDistance(5000, 'metric'), '5.00 km');
});

test('freshness degrades in defined steps', () => {
  assert.equal(freshness(10).level, 'fresh');
  assert.equal(freshness(300).level, 'stale');
  assert.equal(freshness(3600).level, 'lost');
});

console.log(`\n${passed} passed`);
