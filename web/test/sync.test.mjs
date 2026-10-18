/**
 * Sync tests. Run with: node web/test/sync.test.mjs
 *
 * fetch is stubbed with a small in-memory server that follows the real API's
 * contract (web/js/sync.js header; internal/api in Go), and the outbox is a
 * Map, so the push / pull / claim logic runs without a browser or a server.
 */

import assert from 'node:assert/strict';
import { Sync, fromWire } from '../js/sync.js';
import { KDF } from '../js/kdf.js';

// deriveKey('x@y', 'correct horse battery'): what the browser sends. The
// derivation itself is tested in kdf.test.mjs; here it only has to match.
const GOOD_KEY = await (await import('../js/kdf.js')).deriveKey('x@y', 'correct horse battery').then((k) => k.key);

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (err) { console.error('FAIL  ' + name + '\n      ' + (err.stack || err.message)); process.exitCode = 1; }
}

const key = (p) => `${p.deviceId}|${p.ts}`;

class MemOutbox {
  constructor() { this.map = new Map(); }
  add(p) { this.map.set(key(p), p); }
  async peek(limit) { return [...this.map.values()].slice(0, limit); }
  async remove(keys) { for (const [d, t] of keys) this.map.delete(`${d}|${t}`); }
  async count() { return this.map.size; }
}

/** A fake FetchFido server. */
class FakeServer {
  constructor({ mode = 'accounts', authenticated = false, kdf = KDF } = {}) {
    this.mode = mode;
    this.kdf = kdf;
    this.authenticated = authenticated;
    this.claimed = new Set();
    this.stored = new Map();
    this.calls = [];
    this.down = false;
  }
  fetch = async (url, init = {}) => {
    const u = new URL(url, 'http://x');
    this.calls.push(`${init.method || 'GET'} ${u.pathname}`);
    if (this.down) throw new TypeError('Failed to fetch');
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const body = init.body ? JSON.parse(init.body) : null;
    switch (u.pathname) {
      case '/api/v1/me':
        return json(200, { mode: this.mode, authenticated: this.authenticated, registration: true, tokenRequired: this.mode === 'single', retentionDays: 30, kdf: this.kdf });
      case '/api/v1/auth/login':
        if (body.password !== undefined) return json(400, { error: 'raw password sent' });
        if (body.token === 'tok') { this.authenticated = true; return json(200, {}); }
        if (body.kdf !== this.kdf) return json(400, { error: 'this app version derives passwords differently from the server; reload the app' });
        if (body.key === GOOD_KEY) { this.authenticated = true; return json(200, {}); }
        return json(401, { error: 'email or password incorrect' });
      case '/api/v1/auth/logout':
        this.authenticated = false; return json(200, {});
      case '/api/v1/devices/claim':
        if (!this.authenticated) return json(401, { error: 'sign in required' });
        this.claimed.add(body.nodeId); return json(200, { claimed: body.nodeId });
      case '/api/v1/sync': {
        if (!this.authenticated) return json(401, { error: 'sign in required' });
        let accepted = 0, duplicates = 0, invalid = 0;
        const unclaimed = new Set();
        for (const p of body.positions) {
          if (p.lat === 0 && p.lon === 0) { invalid++; continue; }
          if (this.mode === 'accounts' && !this.claimed.has(p.deviceId)) { unclaimed.add(p.deviceId); continue; }
          if (this.stored.has(key(p))) duplicates++; else { this.stored.set(key(p), p); accepted++; }
        }
        return json(200, { accepted, duplicates, invalid, unclaimed: [...unclaimed] });
      }
      case '/api/v1/positions':
        if (!this.authenticated) return json(401, {});
        return json(200, { positions: [...this.stored.values()].map((p) => ({ ...p, provenance: 'phone' })) });
      default:
        return new Response('nope', { status: 404 });
    }
  };
}

const pos = (id, ts) => ({ deviceId: id, ts, lat: 37.7749, lon: -122.4194, alt: null, speed: null, heading: null,
  sats: 7, rssi: -90, snr: 5, hops: 0, hopStart: 3, link: 'mesh' });

console.log('sync');

await test('a plain static host means sync is off and nothing is sent', async () => {
  const ob = new MemOutbox();
  ob.add(pos('!a', 1));
  const s = new Sync(ob, { fetchImpl: async () => new Response('<html>', { status: 404 }) });
  await s.probe();
  assert.equal(s.state, 'off');
  await s.flush();
  assert.equal(await ob.count(), 1, 'outbox untouched');
});

await test('an accounts server needs a sign-in before anything moves', async () => {
  const srv = new FakeServer();
  const ob = new MemOutbox();
  ob.add(pos('!a', 1));
  const s = new Sync(ob, { fetchImpl: srv.fetch });
  await s.probe();
  assert.equal(s.state, 'needs-login');
  await s.flush();
  assert.equal(await ob.count(), 1);
  assert.ok(!srv.calls.includes('POST /api/v1/sync'));
});

await test('unclaimed collars wait in the outbox; claiming releases their history', async () => {
  const srv = new FakeServer();
  const ob = new MemOutbox();
  ob.add(pos('!a', 1)); ob.add(pos('!a', 2)); ob.add(pos('!b', 1));
  const s = new Sync(ob, { fetchImpl: srv.fetch });
  await s.probe();
  await assert.rejects(s.login('x@y', 'wrong password here'), /incorrect/);
  await assert.rejects(s.login('x@y', 'short'), /at least 10/);
  await s.login('x@y', 'correct horse battery');
  assert.equal(s.state, 'idle');
  // login() kicks off a flush; wait for it.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await ob.count(), 3, 'nothing claimed yet, all held');
  assert.deepEqual([...s.unclaimed].sort(), ['!a', '!b']);
  assert.match(s.detail, /unclaimed/);

  assert.equal(await s.claim('!a', 'Fido', 'FIDO'), true);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(srv.stored.size, 2, "Fido's two positions delivered");
  assert.equal(await ob.count(), 1, "!b still waiting");
  assert.deepEqual([...s.unclaimed], ['!b']);
});

await test('single mode with a token: wrong token refused, right token syncs everything', async () => {
  const srv = new FakeServer({ mode: 'single' });
  const ob = new MemOutbox();
  ob.add(pos('!a', 1)); ob.add(pos('!z', 5)); ob.add({ ...pos('!n', 9), lat: 0, lon: 0 });
  const s = new Sync(ob, { fetchImpl: srv.fetch });
  await s.probe();
  assert.equal(s.state, 'needs-login');
  await assert.rejects(s.loginToken('nope'));
  await s.loginToken('tok');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(srv.stored.size, 2);
  assert.equal(await ob.count(), 0, 'the invalid one is dropped, not retried forever');
  assert.equal(s.state, 'idle');
});

await test('wire format drops hopStart and keeps nulls', async () => {
  const srv = new FakeServer({ mode: 'single', authenticated: true });
  const ob = new MemOutbox();
  ob.add(pos('!a', 1));
  const s = new Sync(ob, { fetchImpl: srv.fetch });
  await s.probe();
  await s.flush();
  const sent = srv.stored.get('!a|1');
  assert.equal(sent.hopStart, undefined);
  assert.equal(sent.alt, null);
  assert.equal(sent.rssi, -90);
});

await test('pull feeds server positions back as Positions', async () => {
  const srv = new FakeServer({ mode: 'single', authenticated: true });
  srv.stored.set('!g|7', { deviceId: '!g', ts: 7, lat: 37.7, lon: -122.4, alt: 12, speed: null, heading: null, sats: null, rssi: null, snr: null, hops: 2, link: 'mesh' });
  const s = new Sync(new MemOutbox(), { fetchImpl: srv.fetch });
  const got = [];
  s.onPull((p) => got.push(p));
  await s.probe();
  await s.pull();
  assert.equal(got.length, 1);
  assert.equal(got[0].alt, 12);
  assert.equal(got[0].hopStart, null);
  assert.equal(got[0].link, 'mesh');
  assert.equal(fromWire({ deviceId: 1 }), null);
});

await test('a lost session is reported, not retried blindly', async () => {
  const srv = new FakeServer({ mode: 'accounts', authenticated: true });
  const ob = new MemOutbox();
  const s = new Sync(ob, { fetchImpl: srv.fetch });
  await s.probe();
  srv.authenticated = false;      // server-side expiry
  ob.add(pos('!a', 1));
  await s.flush();
  assert.equal(s.state, 'needs-login');
  assert.equal(await ob.count(), 1);
});

await test('a network failure is an error state with the outbox intact', async () => {
  const srv = new FakeServer({ mode: 'single', authenticated: true });
  const ob = new MemOutbox();
  ob.add(pos('!a', 1));
  const s = new Sync(ob, { fetchImpl: srv.fetch });
  await s.probe();
  srv.down = true;
  await s.flush();
  assert.equal(s.state, 'error');
  assert.equal(await ob.count(), 1);
});

console.log(`\n${passed} passed`);
