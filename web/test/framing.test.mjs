/**
 * Stream framing tests. Run with: node web/test/framing.test.mjs
 *
 * The serial link is the intended off-grid path, so the framer has to survive
 * the two things that actually happen on that wire: plain-text debug logs
 * interleaved with frames, and frames split across arbitrary read boundaries.
 */

import assert from 'node:assert/strict';
import { StreamFramer, frame, MAGIC1, MAGIC2 } from '../js/framing.js';

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

const collect = () => {
  const frames = [];
  const text = [];
  const f = new StreamFramer((x) => frames.push(x), (t) => text.push(t));
  return { f, frames, text };
};

const bytes = (...n) => new Uint8Array(n);
const ascii = (s) => new Uint8Array([...Buffer.from(s, 'ascii')]);

console.log('framing');

test('round-trips a payload through frame() and the parser', () => {
  const { f, frames } = collect();
  f.push(frame(bytes(1, 2, 3, 4)));
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]], [1, 2, 3, 4]);
});

test('header is 0x94 0xC3 then big-endian length', () => {
  const out = frame(new Uint8Array(300));
  assert.equal(out[0], MAGIC1);
  assert.equal(out[1], MAGIC2);
  assert.equal(out[2], 1);   // 300 >> 8
  assert.equal(out[3], 44);  // 300 & 0xff
});

test('handles a frame split across three reads', () => {
  const { f, frames } = collect();
  const whole = frame(bytes(9, 8, 7, 6, 5));
  f.push(whole.slice(0, 2));   // mid-header
  f.push(whole.slice(2, 5));   // length + first payload byte
  f.push(whole.slice(5));
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]], [9, 8, 7, 6, 5]);
});

test('reads several frames from one chunk', () => {
  const { f, frames } = collect();
  const a = frame(bytes(1));
  const b = frame(bytes(2, 2));
  const c = frame(bytes(3, 3, 3));
  f.push(new Uint8Array([...a, ...b, ...c]));
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map((x) => x.length), [1, 2, 3]);
});

test('discards interleaved debug log text', () => {
  // The device writes logs to the same port; they must never reach protobuf.
  const { f, frames, text } = collect();
  f.push(ascii('INFO | Booted\n'));
  f.push(frame(bytes(42)));
  f.push(ascii('DEBUG | Sent packet\n'));
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]], [42]);
  assert.ok(text.some((t) => t.includes('Booted')), 'log text should surface');
  assert.ok(text.some((t) => t.includes('Sent packet')));
});

test('recovers when log text ends mid-magic', () => {
  const { f, frames } = collect();
  f.push(bytes(MAGIC1));            // looks like a header start, is not
  f.push(ascii('oops\n'));
  f.push(frame(bytes(7, 7)));
  assert.equal(frames.length, 1, 'the real frame must still be found');
  assert.deepEqual([...frames[0]], [7, 7]);
});

test('handles 0x94 0x94 0xC3 without losing the frame', () => {
  const { f, frames } = collect();
  const real = frame(bytes(5));
  f.push(new Uint8Array([MAGIC1, ...real]));
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]], [5]);
});

test('resynchronises after an absurd length', () => {
  // 0x94 0xC3 appearing inside binary log noise would otherwise wedge the
  // parser waiting for 60000 bytes that never arrive.
  const { f, frames } = collect();
  f.push(bytes(MAGIC1, MAGIC2, 0xea, 0x60)); // 60000
  f.push(frame(bytes(1, 2)));
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]], [1, 2]);
});

test('accepts a zero-length frame without stalling', () => {
  const { f, frames } = collect();
  f.push(bytes(MAGIC1, MAGIC2, 0, 0));
  f.push(frame(bytes(3)));
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]], [3]);
});

test('counts frames and discarded bytes', () => {
  const { f } = collect();
  f.push(ascii('hello'));
  f.push(frame(bytes(1)));
  assert.equal(f.framesSeen, 1);
  assert.equal(f.bytesDiscarded, 5);
});

test('survives a byte-at-a-time feed', () => {
  const { f, frames } = collect();
  const whole = frame(bytes(11, 22, 33));
  for (const b of whole) f.push(new Uint8Array([b]));
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]], [11, 22, 33]);
});

console.log(`\n${passed} passed`);
