/**
 * Decoder tests. Run with: node web/test/decode.test.mjs
 *
 * These build synthetic Meshtastic frames byte by byte and assert the decoder
 * recovers them. That verifies the hand-written protobuf reader against known
 * input without needing a radio -- the field numbers themselves still need
 * confirming against real hardware (see [verify] markers in meshtastic.js).
 */

import assert from 'node:assert/strict';
import { decodeFromRadio, decodeFrames, nodeId } from '../js/meshtastic.js';
import { Reader } from '../js/protobuf.js';

// ---- minimal protobuf encoder, test-only -----------------------------------

const varint = (n) => {
  const out = [];
  let v = n;
  while (v > 0x7f) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); }
  out.push(v);
  return out;
};

/** Negative int32, sign-extended to ten bytes exactly as protobuf does. */
const int32 = (n) => {
  if (n >= 0) return varint(n);
  const out = [];
  let v = BigInt.asUintN(64, BigInt(n));
  for (let i = 0; i < 9; i++) { out.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
  out.push(Number(v & 0x1n));
  return out;
};

const fixed32 = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, true);
  return [...b];
};

const float32 = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, n, true);
  return [...b];
};

const tag = (field, wire) => varint(field * 8 + wire);
const lenField = (field, body) => [...tag(field, 2), ...varint(body.length), ...body];

// ---- frame construction ----------------------------------------------------

function buildPosition({ lat, lon, alt, time, speed, track, sats }) {
  return [
    ...tag(1, 5), ...fixed32(Math.round(lat * 1e7)),
    ...tag(2, 5), ...fixed32(Math.round(lon * 1e7)),
    ...tag(3, 0), ...int32(alt),
    ...tag(4, 5), ...fixed32(time),
    ...tag(15, 0), ...varint(speed),
    ...tag(16, 0), ...varint(Math.round(track * 1e5)),
    ...tag(19, 0), ...varint(sats),
  ];
}

function buildFrame({ from, rxTime, snr, rssi, hopStart, hopLimit, position, portnum = 3 }) {
  const data = [
    ...tag(1, 0), ...varint(portnum),
    ...lenField(2, position),
  ];
  const packet = [
    ...tag(1, 5), ...fixed32(from | 0),
    ...lenField(4, data),
    ...tag(7, 5), ...fixed32(rxTime),
    ...tag(8, 5), ...float32(snr),
    ...tag(9, 0), ...varint(hopLimit),
    ...tag(12, 0), ...int32(rssi),
    ...tag(15, 0), ...varint(hopStart),
  ];
  return new Uint8Array(lenField(2, packet));
}

// ---- tests -----------------------------------------------------------------

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ok  ' + name);
    passed++;
  } catch (err) {
    console.error('FAIL  ' + name);
    console.error('      ' + err.message);
    process.exitCode = 1;
  }
}

console.log('protobuf reader');

test('varint round-trips a multi-byte value', () => {
  const r = new Reader(new Uint8Array(varint(300)));
  assert.equal(r.varint(), 300);
});

test('varint survives values above 2^31', () => {
  const r = new Reader(new Uint8Array(varint(3_000_000_000)));
  assert.equal(r.varint(), 3_000_000_000);
});

test('int32 decodes a sign-extended negative', () => {
  // The RSSI case: -95 is transmitted as ten bytes, not one.
  const bytes = int32(-95);
  assert.equal(bytes.length, 10, 'expected ten-byte sign extension');
  assert.equal(new Reader(new Uint8Array(bytes)).int32(), -95);
});

test('unknown fields are skipped, not fatal', () => {
  const buf = new Uint8Array([...tag(99, 0), ...varint(7), ...tag(1, 0), ...varint(42)]);
  let seen = null;
  new Reader(buf).each((field, wire, r) => {
    if (field === 1) { seen = r.varint(); return true; }
    return false;
  });
  assert.equal(seen, 42);
});

console.log('meshtastic decode');

const REF = {
  from: 0xa1b2c3d4,
  rxTime: 1_780_000_000,
  snr: 6.25,
  rssi: -95,
  hopStart: 3,
  hopLimit: 1,
  position: buildPosition({
    lat: 37.7955, lon: -122.3937, alt: 12, time: 1_780_000_123,
    speed: 4, track: 271.5, sats: 9,
  }),
};

test('decodes a position frame end to end', () => {
  const p = decodeFromRadio(buildFrame(REF));
  assert.ok(p, 'expected a position');
  assert.equal(p.deviceId, '!a1b2c3d4');
  assert.ok(Math.abs(p.lat - 37.7955) < 1e-6, `lat was ${p.lat}`);
  assert.ok(Math.abs(p.lon - -122.3937) < 1e-6, `lon was ${p.lon}`);
  assert.equal(p.alt, 12);
  assert.equal(p.sats, 9);
  assert.equal(p.link, 'mesh');
});

test('prefers the GPS timestamp over radio receive time', () => {
  const p = decodeFromRadio(buildFrame(REF));
  assert.equal(p.ts, 1_780_000_123);
});

test('carries RSSI, SNR and hop count for field testing', () => {
  const p = decodeFromRadio(buildFrame(REF));
  assert.equal(p.rssi, -95);
  assert.ok(Math.abs(p.snr - 6.25) < 1e-6);
  assert.equal(p.hops, 2, 'hop_start 3 minus hop_limit 1');
});

test('heading is scaled from ground_track', () => {
  const p = decodeFromRadio(buildFrame(REF));
  assert.ok(Math.abs(p.heading - 271.5) < 1e-3, `heading was ${p.heading}`);
});

test('rejects a null island fix', () => {
  const frame = buildFrame({
    ...REF,
    position: buildPosition({ lat: 0, lon: 0, alt: 0, time: 1, speed: 0, track: 0, sats: 0 }),
  });
  assert.equal(decodeFromRadio(frame), null, '0,0 means no GPS fix, not the Gulf of Guinea');
});

test('ignores non-position portnums', () => {
  assert.equal(decodeFromRadio(buildFrame({ ...REF, portnum: 1 })), null);
});

test('ignores a frame carrying no packet', () => {
  assert.equal(decodeFromRadio(new Uint8Array([...tag(1, 0), ...varint(5)])), null);
});

console.log('concatenated bodies (HTTP transport)');

test('returns every position in a multi-message body', () => {
  // The HTTP API returns the whole queue in one response: many FromRadio
  // messages back to back. Keeping only the last would drop real fixes.
  const a = buildFrame({ ...REF, position: buildPosition({ lat: 37.7955, lon: -122.3937, alt: 1, time: 100, speed: 0, track: 0, sats: 5 }) });
  const b = buildFrame({ ...REF, position: buildPosition({ lat: 37.8100, lon: -122.4100, alt: 2, time: 200, speed: 0, track: 0, sats: 6 }) });
  const c = buildFrame({ ...REF, position: buildPosition({ lat: 37.8200, lon: -122.4200, alt: 3, time: 300, speed: 0, track: 0, sats: 7 }) });

  const body = new Uint8Array([...a, ...b, ...c]);
  const all = decodeFrames(body);
  assert.equal(all.length, 3, 'all three positions must survive');
  assert.deepEqual(all.map((p) => p.ts), [100, 200, 300]);
});

test('a position survives being followed by non-position messages', () => {
  // The real failure: a config dump trailing the packet meant the last field-2
  // was not a position, so the position ahead of it was discarded.
  const pos = buildFrame(REF);
  const other = new Uint8Array([...tag(7, 0), ...varint(42)]); // config_complete_id
  const body = new Uint8Array([...pos, ...other]);
  assert.equal(decodeFrames(body).length, 1);
});

test('tolerates a body with no positions at all', () => {
  // What the config handshake actually returns: ~50 messages, no packets.
  const body = new Uint8Array([
    ...lenField(3, [...tag(1, 0), ...varint(7)]),   // my_info
    ...lenField(4, [...tag(1, 0), ...varint(9)]),   // node_info
    ...tag(7, 0), ...varint(42),                    // config_complete_id
  ]);
  assert.deepEqual(decodeFrames(body), []);
});

test('nodeId formats unsigned', () => {
  assert.equal(nodeId(0xa1b2c3d4), '!a1b2c3d4');
  assert.equal(nodeId(0x0000000f), '!0000000f');
});

console.log(`\n${passed} passed`);
