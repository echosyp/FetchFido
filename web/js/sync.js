// @ts-check
/**
 * Server sync: push what this phone heard, pull what other devices heard.
 *
 * The server is a sync target, never a dependency (docs/DESIGN.md section 1).
 * Everything here degrades to "no server": the app tracks exactly as before,
 * and positions queue in an outbox until a server is reachable and signed in.
 *
 * The server is whatever origin served the page. The self-hosted binary and
 * the hosted Worker both serve the PWA and /api/v1 from one origin, so there
 * is nothing to configure, and a plain static host (python -m http.server)
 * simply has no /api/v1/me and sync stays off.
 *
 * Two server modes, told apart by /api/v1/me:
 *   single    no accounts; maybe a shared access token
 *   accounts  email + password; only claimed collars are stored server-side
 *
 * Passwords never leave the phone. The browser derives a key from them
 * (kdf.js) and that is what register and login send.
 */

import { deriveKey, KDF } from './kdf.js';

/** @typedef {import('./meshtastic.js').Position} Position */

/**
 * What the outbox must provide. Kept as an interface so the sync logic is
 * testable without IndexedDB.
 * @typedef {object} Outbox
 * @property {(limit: number) => Promise<Position[]>} peek
 * @property {(keys: [string, number][]) => Promise<void>} remove
 * @property {() => Promise<number>} count
 */

/** @typedef {'off'|'needs-login'|'idle'|'syncing'|'error'} SyncState */

/**
 * @typedef {object} ServerInfo
 * @property {'single'|'accounts'} mode
 * @property {boolean} authenticated
 * @property {boolean} registration
 * @property {boolean} tokenRequired
 * @property {number} retentionDays
 * @property {string} [email]
 * @property {string} [kdf] the password derivation the server expects
 */

const BATCH = 500;
const PUSH_MS = 20000;
const PULL_MS = 60000;
/** How far back the first pull reaches. Older history is on the server's export. */
const PULL_WINDOW_S = 24 * 3600;

export class Sync {
  /**
   * @param {Outbox} outbox
   * @param {{fetchImpl?: typeof fetch, base?: string}} [opts]
   */
  constructor(outbox, opts = {}) {
    this.outbox = outbox;
    this._fetch = opts.fetchImpl || ((...a) => globalThis.fetch(...a));
    this.base = opts.base ?? '';
    /** @type {ServerInfo|null} null until a server has answered */
    this.info = null;
    /** @type {SyncState} */
    this.state = 'off';
    this.detail = '';
    this.pending = 0;
    /** Node IDs the server refused as unclaimed, so the UI can say so. */
    this.unclaimed = /** @type {Set<string>} */ (new Set());
    /** @type {((state: SyncState, detail: string, pending: number) => void)[]} */
    this._cbs = [];
    /** @type {((p: Position) => void)[]} */
    this._pullCbs = [];
    /** @type {ReturnType<typeof setInterval>|null} */
    this._pushTimer = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    this._pullTimer = null;
    this._lastPull = 0;
    this._busy = false;
  }

  /** @param {(state: SyncState, detail: string, pending: number) => void} cb */
  onStatus(cb) { this._cbs.push(cb); }

  /** Positions pulled from the server, to be stored and rendered like any other. */
  /** @param {(p: Position) => void} cb */
  onPull(cb) { this._pullCbs.push(cb); }

  /**
   * @param {SyncState} state
   * @param {string} [detail]
   */
  async _set(state, detail = '') {
    this.state = state;
    this.detail = detail;
    try { this.pending = await this.outbox.count(); } catch { /* keep last */ }
    for (const cb of this._cbs) cb(state, detail, this.pending);
  }

  /**
   * Find out whether the origin is a FetchFido server, and who we are to it.
   * @returns {Promise<ServerInfo|null>}
   */
  async probe() {
    try {
      const res = await this._fetch(this.base + '/api/v1/me', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('not a FetchFido server');
      this.info = /** @type {ServerInfo} */ (await res.json());
    } catch {
      this.info = null;
    }
    if (!this.info) await this._set('off', 'no server');
    else if (!this.info.authenticated) await this._set('needs-login', this.info.mode === 'accounts' ? 'sign in to sync' : 'access token needed');
    else await this._set('idle');
    return this.info;
  }

  /** Probe, then keep pushing and pulling while the page lives. */
  async start() {
    await this.probe();
    if (this._pushTimer) clearInterval(this._pushTimer);
    this._pushTimer = setInterval(() => void this.flush(), PUSH_MS);
    if (this._pullTimer) clearInterval(this._pullTimer);
    this._pullTimer = setInterval(() => void this.pull(), PULL_MS);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => void this.flush());
    }
    await this.flush();
    await this.pull();
  }

  get ready() {
    return !!this.info && this.info.authenticated;
  }

  /**
   * Upload the outbox in batches. Idempotent server-side, so a retry after a
   * failed response cannot double-count anything.
   */
  async flush() {
    if (this._busy) return;
    if (!this.info) return;
    if (!this.ready) { await this._set('needs-login', this.detail || 'sign in to sync'); return; }
    this._busy = true;
    try {
      for (;;) {
        const batch = await this.outbox.peek(BATCH);
        if (batch.length === 0) break;
        await this._set('syncing', `${batch.length} to send`);
        const res = await this._post('/api/v1/sync', { positions: batch.map(wire) });
        if (res.status === 401) { this.info.authenticated = false; await this._set('needs-login', 'session expired'); return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const out = await res.json();
        // Unclaimed nodes stay queued: claiming them later makes the next
        // flush deliver the history. Everything else the server has dealt
        // with -- stored, already had, or found invalid -- leaves the queue.
        const held = new Set(/** @type {string[]} */ (out.unclaimed || []));
        this.unclaimed = held;
        const done = batch.filter((p) => !held.has(p.deviceId)).map((p) => /** @type {[string, number]} */ ([p.deviceId, p.ts]));
        await this.outbox.remove(done);
        if (done.length === 0) {
          // Only unclaimed positions remain; nothing more will move until a claim.
          await this._set('idle', `${batch.length} waiting on unclaimed collars`);
          return;
        }
      }
      await this._set('idle');
    } catch (err) {
      await this._set('error', err instanceof Error ? err.message : String(err));
    } finally {
      this._busy = false;
    }
  }

  /**
   * Fetch what the server holds that we may not: positions uploaded by other
   * phones or gateways. Fed back through the normal position path, where the
   * store's dedupe discards what we already have.
   */
  async pull() {
    if (!this.ready) return;
    const now = Math.floor(Date.now() / 1000);
    const from = this._lastPull ? this._lastPull - 60 : now - PULL_WINDOW_S;
    try {
      const res = await this._fetch(this.base + `/api/v1/positions?from=${from}&limit=5000`, { credentials: 'same-origin' });
      if (res.status === 401) { if (this.info) this.info.authenticated = false; await this._set('needs-login', 'session expired'); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = await res.json();
      this._lastPull = now;
      for (const raw of out.positions || []) {
        const p = fromWire(raw);
        if (p) for (const cb of this._pullCbs) cb(p);
      }
    } catch (err) {
      await this._set('error', `pull: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- accounts -----------------------------------------------------------

  /** @param {string} email @param {string} password */
  async register(email, password) {
    await this._auth('/api/v1/auth/register', { email, ...(await this._derive(email, password)) });
  }

  /** @param {string} email @param {string} password */
  async login(email, password) {
    await this._auth('/api/v1/auth/login', { email, ...(await this._derive(email, password)) });
  }

  /**
   * The server names the derivation it expects. If it is not the one this
   * app implements, say so before spending half a second deriving a key the
   * server would refuse anyway.
   * @param {string} email @param {string} password
   */
  async _derive(email, password) {
    const want = this.info?.kdf;
    if (want && want !== KDF) {
      throw new Error('this app version derives passwords differently from the server; reload the app');
    }
    return deriveKey(email, password);
  }

  /** Single mode with an access token. @param {string} token */
  async loginToken(token) {
    await this._auth('/api/v1/auth/login', { token });
  }

  async logout() {
    await this._post('/api/v1/auth/logout', {});
    await this.probe();
  }

  /** @param {string} path @param {object} body */
  async _auth(path, body) {
    const res = await this._post(path, body);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch { /* keep */ }
      throw new Error(msg);
    }
    await this.probe();
    // Settle before returning so the caller sees the real state, not a flush
    // caught mid-flight.
    await this.flush();
    await this.pull();
  }

  // ---- claims -------------------------------------------------------------

  /**
   * Tell the server this node is ours. In accounts mode that is what lets its
   * positions be stored at all; in single mode it is naming.
   * @param {string} nodeId @param {string} name @param {string} [shortName]
   */
  async claim(nodeId, name, shortName = '') {
    if (!this.ready) return false;
    const res = await this._post('/api/v1/devices/claim', { nodeId, name, shortName, colour: '' });
    if (res.ok) {
      this.unclaimed.delete(nodeId);
      void this.flush();
    }
    return res.ok;
  }

  /** @returns {Promise<{nodeId: string, name: string, shortName: string}[]>} */
  async devices() {
    if (!this.ready) return [];
    const res = await this._fetch(this.base + '/api/v1/devices', { credentials: 'same-origin' });
    if (!res.ok) return [];
    return (await res.json()).devices || [];
  }

  /** @param {string} path @param {object} body */
  _post(path, body) {
    return this._fetch(this.base + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}

/**
 * The server's record is the app's minus hopStart (a sender setting, not a
 * fact about the fix) and with nulls kept as nulls.
 * @param {Position} p
 */
function wire(p) {
  return {
    deviceId: p.deviceId, ts: p.ts, lat: p.lat, lon: p.lon,
    alt: p.alt, speed: p.speed, heading: p.heading, sats: p.sats,
    rssi: p.rssi, snr: p.snr, hops: p.hops, link: p.link,
  };
}

/**
 * @param {any} r
 * @returns {Position|null}
 */
export function fromWire(r) {
  if (!r || typeof r.deviceId !== 'string' || typeof r.ts !== 'number') return null;
  if (typeof r.lat !== 'number' || typeof r.lon !== 'number') return null;
  return {
    deviceId: r.deviceId, ts: r.ts, lat: r.lat, lon: r.lon,
    alt: r.alt ?? null, speed: r.speed ?? null, heading: r.heading ?? null, sats: r.sats ?? null,
    rssi: r.rssi ?? null, snr: r.snr ?? null, hops: r.hops ?? null, hopStart: null,
    link: r.link === 'nodedb' ? 'nodedb' : 'mesh',
  };
}
