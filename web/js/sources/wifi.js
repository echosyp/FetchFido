// @ts-check
/**
 * HTTP transport to a WiFi-connected Meshtastic node.
 *
 * This is the only transport that works on iOS, which has neither Web
 * Bluetooth nor Web Serial (docs/DESIGN.md section 5.1). It requires an
 * ESP32-class node -- nRF52 boards (T-Echo, RAK4631) have no WiFi radio.
 *
 * Protocol [verify against firmware]:
 *   GET  {base}/api/v1/fromradio?all=true  -> one FromRadio protobuf frame,
 *                                             zero-length body when drained
 *   PUT  {base}/api/v1/toradio             -> one ToRadio protobuf frame
 *
 * Two browser constraints govern deployment:
 *
 *  1. Mixed content. A node speaking plain http cannot be reached from a page
 *     served over https. Serve the PWA over http (or from the node itself)
 *     when using this transport.
 *  2. Private Network Access. Chrome restricts requests from public origins to
 *     private IPs. Serving from the same LAN avoids this entirely.
 */

import { decodeFrames, wantConfig } from '../meshtastic.js';
import { BaseSource } from './base.js';

/** Back-off when the radio has nothing queued. */
const IDLE_MS = 1500;
/** Give up on a single request this long after starting it. */
const TIMEOUT_MS = 8000;

export class WifiSource extends BaseSource {
  /**
   * @param {string} address host, ip, or full URL
   * @param {typeof fetch} [fetchImpl] injectable for tests
   */
  constructor(address, fetchImpl) {
    super('WiFi');
    this.base = normaliseBase(address);
    this._fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    /** @type {AbortController|null} */
    this._abort = null;
    this._running = false;
  }

  available() {
    return typeof globalThis.fetch === 'function';
  }

  async connect() {
    if (this._running) return;
    this._setStatus('connecting', this.base);
    this._abort = new AbortController();

    try {
      // Ask the radio to start streaming. Some firmware happily serves
      // fromradio without this, so a failure here is not fatal -- but a
      // failure to reach the node at all is.
      try {
        await this._request('PUT', 'api/v1/toradio',
          wantConfig(Math.floor(Math.random() * 0xffffffff)));
      } catch (err) {
        console.warn('want_config failed, continuing', err);
      }

      // Prove reachability before claiming connected. Whatever arrives in the
      // probe is emitted, not discarded -- the radio may already have a
      // position queued, and dropping it would lose a real fix.
      await this._pollOnce();

      this._running = true;
      this._setStatus('connected', this.base);
      void this._loop();
    } catch (err) {
      this._abort = null;
      const msg = err instanceof Error ? err.message : String(err);
      this._setStatus('offline', describe(msg, this.base));
      throw err;
    }
  }

  async disconnect() {
    this._running = false;
    this._abort?.abort();
    this._abort = null;
    this._setStatus('offline');
  }

  /**
   * Poll until stopped.
   *
   * Drains greedily while frames keep arriving, then backs off. Polling hard
   * at a fixed interval would either lag behind a burst or waste the node's
   * limited HTTP capacity while idle.
   */
  async _loop() {
    let failures = 0;
    while (this._running) {
      try {
        const bytes = await this._pollOnce();
        failures = 0;

        if (bytes === 0) {
          if (this._status !== 'connected') this._setStatus('connected', this.base);
          await sleep(IDLE_MS, this._abort?.signal);
        }
        // Otherwise loop straight back round: more frames may be queued.
      } catch (err) {
        if (!this._running) return; // aborted by disconnect(), not a fault
        failures++;
        const msg = err instanceof Error ? err.message : String(err);
        this._setStatus('degraded', `${msg} (${failures})`);
        // Ease off a struggling node rather than hammering it.
        await sleep(Math.min(IDLE_MS * failures, 15000), this._abort?.signal);
      }
    }
  }

  /**
   * Fetch one frame and emit it if it decodes to a position.
   * @returns {Promise<number>} bytes received; 0 means the queue is drained
   */
  async _pollOnce() {
    const body = await this._request('GET', 'api/v1/fromradio?all=true');
    if (body.byteLength === 0) return 0;
    try {
      // One response can carry many FromRadio messages; emit every position.
      for (const pos of decodeFrames(body)) this._emit(pos);
    } catch (err) {
      // A malformed body must not kill the poll loop.
      console.warn('frame decode failed', err);
    }
    return body.byteLength;
  }

  /**
   * @param {'GET'|'PUT'} method
   * @param {string} path
   * @param {Uint8Array} [body]
   * @returns {Promise<Uint8Array>}
   */
  async _request(method, path, body) {
    const signal = this._abort?.signal;
    const timer = setTimeout(() => this._abort?.abort(), TIMEOUT_MS);
    try {
      const res = await this._fetch(this.base + path, {
        method,
        signal,
        headers: { Accept: 'application/x-protobuf' },
        ...(body ? { body, headers: { 'Content-Type': 'application/x-protobuf' } } : {}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Accept "192.168.1.50", "node.lan", or a full URL, and return a base ending
 * in a slash.
 * @param {string} address
 * @returns {string}
 */
export function normaliseBase(address) {
  let a = (address || '').trim();
  if (!a) throw new Error('node address required');
  if (!/^https?:\/\//i.test(a)) a = 'http://' + a;
  if (!a.endsWith('/')) a += '/';
  return a;
}

/**
 * Turn an opaque fetch failure into something actionable. A cross-origin
 * block, a mixed-content block, and an unreachable host all surface as the
 * same bare "Failed to fetch".
 * @param {string} msg
 * @param {string} base
 * @returns {string}
 */
function describe(msg, base) {
  if (!/failed to fetch|networkerror|load failed/i.test(msg)) return msg;
  if (base.startsWith('http://') && globalThis.location?.protocol === 'https:') {
    return 'blocked: page is https, node is http (mixed content)';
  }
  return 'unreachable, or blocked by CORS';
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(undefined); }, { once: true });
  });
}
