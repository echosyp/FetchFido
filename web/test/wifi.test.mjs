/**
 * WifiSource tests. Run with: node web/test/wifi.test.mjs
 *
 * fetch is injected, so the polling loop, drain behaviour, error handling and
 * URL construction are all verifiable without a radio on the network.
 */

import assert from 'node:assert/strict';
import { WifiSource, normaliseBase } from '../js/sources/wifi.js';

let passed = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push('  ok  ' + name);
    passed++;
  } catch (err) {
    results.push('FAIL  ' + name + '\n      ' + err.message);
    process.exitCode = 1;
  }
}

/** Build a fetch stub that serves a queue of frames, then empties. */
function stubFetch(frames) {
  const calls = [];
  const queue = [...frames];
  return {
    calls,
    fetch: async (url, opts) => {
      calls.push({ url, method: opts?.method });
      // Only fromradio serves queued frames; a PUT to toradio returns nothing,
      // as the real firmware does.
      const serving = String(url).includes('fromradio');
      const body = serving && queue.length ? queue.shift() : new Uint8Array(0);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      };
    },
  };
}

/** A valid FromRadio frame carrying a position, built the same way as decode.test.mjs. */
function positionFrame(lat, lon) {
  const varint = (n) => { const o = []; let v = n; while (v > 0x7f) { o.push((v % 128) | 0x80); v = Math.floor(v / 128); } o.push(v); return o; };
  const tag = (f, w) => varint(f * 8 + w);
  const len = (f, b) => [...tag(f, 2), ...varint(b.length), ...b];
  const fixed = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n, true); return [...b]; };

  const position = [
    ...tag(1, 5), ...fixed(Math.round(lat * 1e7)),
    ...tag(2, 5), ...fixed(Math.round(lon * 1e7)),
    ...tag(4, 5), ...fixed(1_780_000_000),
  ];
  const data = [...tag(1, 0), ...varint(3), ...len(2, position)];
  const packet = [...tag(1, 5), ...fixed(0x11223344 | 0), ...len(4, data)];
  return new Uint8Array(len(2, packet));
}

console.log('normaliseBase');

await test('adds scheme and trailing slash to a bare IP', () => {
  assert.equal(normaliseBase('192.168.1.50'), 'http://192.168.1.50/');
});

await test('preserves an explicit scheme', () => {
  assert.equal(normaliseBase('https://node.lan'), 'https://node.lan/');
});

await test('tolerates surrounding whitespace and an existing slash', () => {
  assert.equal(normaliseBase('  node.lan/  '), 'http://node.lan/');
});

await test('rejects an empty address', () => {
  assert.throws(() => normaliseBase('   '), /address required/);
});

console.log('WifiSource');

await test('connects and reports the node address', async () => {
  const stub = stubFetch([]);
  const src = new WifiSource('192.168.1.50', stub.fetch);
  /** @type {string[]} */
  const states = [];
  src.onStatus((s) => states.push(s));
  await src.connect();
  await src.disconnect();
  assert.ok(states.includes('connecting'), 'should announce connecting');
  assert.ok(states.includes('connected'), 'should reach connected');
});

await test('requests the documented endpoints', async () => {
  const stub = stubFetch([]);
  const src = new WifiSource('node.lan', stub.fetch);
  await src.connect();
  await src.disconnect();
  const urls = stub.calls.map((c) => c.url);
  assert.ok(urls.some((u) => u === 'http://node.lan/api/v1/toradio'), 'should PUT toradio');
  assert.ok(urls.some((u) => u.startsWith('http://node.lan/api/v1/fromradio')), 'should GET fromradio');
  assert.equal(stub.calls.find((c) => c.url.endsWith('toradio')).method, 'PUT');
});

await test('decodes positions delivered by the poll loop', async () => {
  const stub = stubFetch([positionFrame(37.7955, -122.3937), positionFrame(37.8, -122.4)]);
  const src = new WifiSource('192.168.1.50', stub.fetch);
  const got = [];
  src.onPosition((p) => got.push(p));
  await src.connect();
  // Let the loop drain the queue.
  await new Promise((r) => setTimeout(r, 60));
  await src.disconnect();
  assert.ok(got.length >= 1, `expected positions, got ${got.length}`);
  assert.equal(got[0].deviceId, '!11223344');
  assert.ok(Math.abs(got[0].lat - 37.7955) < 1e-6);
});

await test('surfaces an unreachable node instead of claiming connected', async () => {
  const failing = async () => { throw new TypeError('Failed to fetch'); };
  const src = new WifiSource('10.0.0.1', failing);
  /** @type {string[]} */
  const details = [];
  src.onStatus((s, d) => { if (s === 'offline' && d) details.push(d); });
  await assert.rejects(() => src.connect());
  assert.equal(src.status(), 'offline');
  assert.ok(details.some((d) => /unreachable|CORS/i.test(d)), `got: ${details.join('|')}`);
});

await test('a non-200 response is a failure, not empty data', async () => {
  const bad = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
  const src = new WifiSource('10.0.0.1', bad);
  await assert.rejects(() => src.connect(), /HTTP 404/);
});

await test('disconnect stops the poll loop', async () => {
  const stub = stubFetch([]);
  const src = new WifiSource('192.168.1.50', stub.fetch);
  await src.connect();
  await src.disconnect();
  const after = stub.calls.length;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(stub.calls.length, after, 'no requests should follow disconnect');
});

console.log(results.join('\n'));
console.log(`\n${passed} passed`);
