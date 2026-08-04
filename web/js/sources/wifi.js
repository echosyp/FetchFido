// @ts-check
/**
 * HTTP transport to a WiFi-connected Meshtastic node.
 *
 * This is the only transport that works on iOS, which has neither Web
 * Bluetooth nor Web Serial (docs/DESIGN.md section 5.1). It requires an
 * ESP32-class node -- nRF52 boards (T-Echo, RAK4631) have no WiFi radio.
 *
 * Protocol, confirmed against real firmware 2026-08-02:
 *   GET  {base}/api/v1/fromradio?all=true  -> one FromRadio protobuf frame,
 *                                             zero-length body when drained
 *   PUT  {base}/api/v1/toradio             -> one ToRadio protobuf frame
 *
 * The want_config handshake is MANDATORY: before it the radio queues nothing
 * and fromradio returns Content-Length: 0 indefinitely. After it, the queue
 * delivers the node database and then live packets.
 *
 * A response body holds MANY FromRadio messages concatenated -- the handshake
 * alone returned ~50 in 1479 bytes. Decoding only the first or last loses
 * real positions.
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
/**
 * Re-request the node database after this long without a position.
 *
 * The node database arrives only with the want_config handshake, but it is the
 * radio's live view of the mesh -- on a quiet mesh it is fresher than waiting
 * for a node to happen to broadcast. Without this the map freezes at whatever
 * was true when you connected.
 */
const REFRESH_MS = 120000;

export class WifiSource extends BaseSource {
  /**
   * @param {string} address host, ip, or full URL
   * @param {typeof fetch} [fetchImpl] injectable for tests
   * @param {number} [timeoutMs] per-request timeout
   * @param {number} [idleMs] poll back-off
   */
  constructor(address, fetchImpl, timeoutMs = TIMEOUT_MS, idleMs = IDLE_MS) {
    super('WiFi');
    this.base = normaliseBase(address);
    this._fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this._timeoutMs = timeoutMs;
    this._idleMs = idleMs;
    /** @type {AbortController|null} */
    this._abort = null;
    this._running = false;
    this._lastPosition = 0;
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
        await this._send(wantConfig(Math.floor(Math.random() * 0xffffffff)));
      } catch (err) {
        console.warn('want_config failed, continuing', err);
      }
      this._lastPosition = Date.now();

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

        if (Date.now() - this._lastPosition > REFRESH_MS) {
          // Nothing heard lately: ask for the node database again rather than
          // sit on a stale map waiting for a broadcast that may not come.
          this._lastPosition = Date.now();
          try {
            await this._send(wantConfig(Math.floor(Math.random() * 0xffffffff)));
          } catch (err) {
            console.warn('node database refresh failed', err);
          }
        }

        if (bytes === 0) {
          if (this._status !== 'connected') this._setStatus('connected', this.base);
          await sleep(this._idleMs, this._abort?.signal);
        }
        // Otherwise loop straight back round: more frames may be queued.
      } catch (err) {
        if (!this._running) return; // aborted by disconnect(), not a fault
        failures++;
        const msg = err instanceof Error ? err.message : String(err);
        this._setStatus('degraded', `${msg} (${failures})`);
        // Ease off a struggling node rather than hammering it.
        await sleep(Math.min(this._idleMs * failures, 15000), this._abort?.signal);
      }
    }
  }

  /**
   * Send a ToRadio message.
   * @param {Uint8Array} payload
   */
  async _send(payload) {
    await this._request('PUT', 'api/v1/toradio', payload);
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
      for (const pos of decodeFrames(body)) {
        this._lastPosition = Date.now();
        this._emit(pos);
      }
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
    // A per-request controller. Timing out must not poison the connection:
    // aborting the shared controller would make every later request fail
    // instantly with AbortError, leaving the transport permanently degraded
    // after one slow response. The connection-level signal is chained in so
    // disconnect() still cancels whatever is in flight.
    const ctl = new AbortController();
    const cancel = () => ctl.abort();
    const outer = this._abort?.signal;
    if (outer) {
      if (outer.aborted) ctl.abort();
      else outer.addEventListener('abort', cancel, { once: true });
    }
    const timer = setTimeout(cancel, this._timeoutMs);

    try {
      const res = await this._fetch(this.base + path, {
        method,
        signal: ctl.signal,
        headers: { Accept: 'application/x-protobuf' },
        ...(body ? { body, headers: { 'Content-Type': 'application/x-protobuf' } } : {}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', cancel);
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
