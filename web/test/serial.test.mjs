/**
 * Serial port matching. Run with: node web/test/serial.test.mjs
 *
 * Replug recovery hinges on picking the right previously-granted port without
 * a user gesture. It is the only part of the serial path testable without
 * hardware, and getting it wrong means silently attaching to the wrong device.
 */

import assert from 'node:assert/strict';
import { matchPort } from '../js/sources/serial.js';

let passed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  ' + name); passed++; }
  catch (err) { console.error('FAIL  ' + name + '\n      ' + err.message); process.exitCode = 1; }
}

const port = (vid, pid) => ({ getInfo: () => ({ usbVendorId: vid, usbProductId: pid }) });

console.log('serial port matching');

test('no granted ports means nothing to resume', () => {
  assert.equal(matchPort([], { vid: 0x239a, pid: 0x8029 }), null);
});

test('matches the remembered device among several', () => {
  const want = port(0x239a, 0x8029);           // T1000-E
  const ports = [port(0x10c4, 0xea60), want];  // plus a CP2102
  assert.equal(matchPort(ports, { vid: 0x239a, pid: 0x8029 }), want);
});

test('falls back to a lone port when it does not match', () => {
  // After a firmware update a board can enumerate with a different pid; a
  // single candidate is almost certainly still the right device.
  const only = port(0x239a, 0x0029);
  assert.equal(matchPort([only], { vid: 0x239a, pid: 0x8029 }), only);
});

test('refuses to guess between several non-matching ports', () => {
  const ports = [port(0x10c4, 0xea60), port(0x1a86, 0x7523)];
  assert.equal(matchPort(ports, { vid: 0x239a, pid: 0x8029 }), null,
    'attaching to an arbitrary unrelated device would be worse than failing');
});

test('with nothing remembered, takes the first granted port', () => {
  const a = port(0x10c4, 0xea60);
  assert.equal(matchPort([a, port(0x1a86, 0x7523)], null), a);
});

console.log(`\n${passed} passed`);
