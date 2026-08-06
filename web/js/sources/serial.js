// @ts-check
/**
 * Web Serial transport -- a node on a cable.
 *
 * The preferred off-grid handheld link: no pairing, no dropouts, and the cable
 * keeps the node charged. Works on desktop Chrome and on Chrome for Android
 * 150+ (with an OTG cable); Safari does not implement Web Serial at all.
 *
 * Requires a secure context, exactly like Web Bluetooth. Off-grid that means
 * the app must have been installed from https or a flagged origin BEFORE
 * leaving connectivity -- see web/README.md.
 *
 * Unlike the HTTP transport, the serial protocol is framed and the device
 * interleaves plain-text logs on the same port; see js/framing.js.
 *
 * Verified 2026-08-05 against a real node, driven from the hosted HTTPS build.
 */

import { decodeFrames, wantConfig } from '../meshtastic.js';
import { StreamFramer, frame } from '../framing.js';
import { BaseSource } from './base.js';

/** Meshtastic's serial API runs at this rate. Ignored by native-USB boards. */
const BAUD = 115200;

export class SerialSource extends BaseSource {
  constructor() {
    super('Serial');
    /** @type {SerialPort|null} */
    this._port = null;
    /** @type {ReadableStreamDefaultReader<Uint8Array>|null} */
    this._reader = null;
    this._running = false;
    /** Recent device log lines, useful when nothing else explains a silence. */
    this.log = /** @type {string[]} */ ([]);
  }

  available() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  /** Must be called from a user gesture, or the port chooser will not open. */
  async connect() {
    if (!this.available()) {
      throw new Error('Web Serial unavailable (needs Chrome; not supported on iOS)');
    }

    this._setStatus('connecting');
    try {
      // Deliberately unfiltered: Meshtastic boards ship with several different
      // USB bridges (CP2102, CH340, native nRF52/ESP32-S3 CDC), and a filter
      // that misses one hides the device from the chooser entirely.
      this._port = await navigator.serial.requestPort();
      await this._port.open({ baudRate: BAUD });

      const framer = new StreamFramer(
        (payload) => {
          try {
            for (const pos of decodeFrames(payload)) this._emit(pos);
          } catch (err) {
            console.warn('frame decode failed', err);
          }
        },
        (line) => {
          this.log.push(line);
          if (this.log.length > 200) this.log.shift();
        }
      );

      this._running = true;
      this._setStatus('connected', portLabel(this._port));

      // Start reading before the handshake, so the reply cannot be missed.
      void this._read(framer);
      await this._send(wantConfig(Math.floor(Math.random() * 0xffffffff)));
    } catch (err) {
      this._running = false;
      this._setStatus('offline', err instanceof Error ? err.message : String(err));
      await this._cleanup();
      throw err;
    }
  }

  async disconnect() {
    this._running = false;
    await this._cleanup();
    this._setStatus('offline');
  }

  /**
   * @param {StreamFramer} framer
   */
  async _read(framer) {
    if (!this._port?.readable) return;
    this._reader = this._port.readable.getReader();
    try {
      while (this._running) {
        const { value, done } = await this._reader.read();
        if (done) break;
        if (value) framer.push(value);
      }
    } catch (err) {
      if (this._running) {
        this._setStatus('degraded', err instanceof Error ? err.message : String(err));
      }
    } finally {
      try {
        this._reader.releaseLock();
      } catch {
        // Already released by cancel(); nothing to do.
      }
      this._reader = null;
    }
  }

  /** @param {Uint8Array} payload */
  async _send(payload) {
    if (!this._port?.writable) throw new Error('port not writable');
    const writer = this._port.writable.getWriter();
    try {
      await writer.write(frame(payload));
    } finally {
      writer.releaseLock();
    }
  }

  async _cleanup() {
    try {
      await this._reader?.cancel();
    } catch {
      // Reader may already be closed.
    }
    try {
      await this._port?.close();
    } catch {
      // Port may already be closed, or never opened.
    }
    this._reader = null;
    this._port = null;
  }
}

/**
 * @param {SerialPort} port
 * @returns {string}
 */
function portLabel(port) {
  const info = port.getInfo?.() || {};
  const vid = info.usbVendorId;
  const pid = info.usbProductId;
  if (vid === undefined) return 'serial port';
  const hex = (n) => n.toString(16).padStart(4, '0');
  return `usb ${hex(vid)}:${hex(pid ?? 0)}`;
}
