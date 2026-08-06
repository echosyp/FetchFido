// @ts-check
/**
 * Web Bluetooth transport to a Meshtastic node.
 *
 * Verified 2026-08-05 from the hosted PWA against a real node.
 *
 * This is the load-bearing transport on mobile: Web Serial does not reach a
 * node on Android in practice, and the WiFi transport is blocked from an https
 * page by mixed content. Off-grid on a phone, this is the path.
 *
 * Platform note: Web Bluetooth exists in Chrome on Android and desktop, and
 * NOT in Safari on iOS. Requires a secure context -- https, or localhost
 * during development.
 */

import { BLE, decodeFromRadio, wantConfig } from '../meshtastic.js';
import { BaseSource } from './base.js';

/** Reconnect back-off, milliseconds. Grows, then holds. */
const BACKOFF = [1000, 2000, 4000, 8000, 15000, 30000];

export class BleSource extends BaseSource {
  constructor() {
    super('Bluetooth');
    /** @type {BluetoothDevice|null} */
    this._device = null;
    /** @type {BluetoothRemoteGATTCharacteristic|null} */
    this._fromRadio = null;
    /** @type {BluetoothRemoteGATTCharacteristic|null} */
    this._toRadio = null;
    this._draining = false;
    /** User intent, as distinct from current state: survives a dropout. */
    this._wantConnected = false;
    this._attempt = 0;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._retryTimer = null;
  }

  available() {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  /**
   * Must be called from a user gesture -- the browser will not show the
   * device chooser otherwise. Reconnects afterwards need no gesture, because
   * the permission is attached to the device object we keep hold of.
   */
  async connect() {
    if (!this.available()) throw new Error('Web Bluetooth unavailable in this browser');

    this._wantConnected = true;
    this._setStatus('connecting');
    try {
      this._device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [BLE.SERVICE] }],
        optionalServices: [BLE.SERVICE],
      });

      this._device.addEventListener('gattserverdisconnected', () => this._onDropped());
      await this._attach();
    } catch (err) {
      this._wantConnected = false;
      this._setStatus('offline', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * Open GATT and subscribe. Used by connect() and by every reconnect.
   *
   * Service and characteristic objects do not survive a disconnect, so they
   * are re-fetched each time rather than cached across the gap.
   */
  async _attach() {
    if (!this._device) throw new Error('no device');

    const server = await this._device.gatt?.connect();
    if (!server) throw new Error('GATT connect failed');

    const service = await server.getPrimaryService(BLE.SERVICE);
    this._fromRadio = await service.getCharacteristic(BLE.FROM_RADIO);
    this._toRadio = await service.getCharacteristic(BLE.TO_RADIO);
    const fromNum = await service.getCharacteristic(BLE.FROM_NUM);

    // fromNum notifies that data is waiting; the actual frames are then
    // pulled by reading fromRadio until it returns empty.
    await fromNum.startNotifications();
    fromNum.addEventListener('characteristicvaluechanged', () => {
      void this._drain();
    });

    // Ask the radio to send its config and start streaming.
    await this._toRadio.writeValue(wantConfig(Math.floor(Math.random() * 0xffffffff)));

    this._attempt = 0;
    this._setStatus('connected', this._device.name || 'radio');
    await this._drain();
  }

  /**
   * The link dropped.
   *
   * On a walk this is expected rather than exceptional -- the phone moves, the
   * node is on a collar, and BLE range is short. Requiring the handler to
   * notice and re-pick the device from a chooser would turn a momentary
   * dropout into a silent hole in the track, easily mistaken for a radio
   * range limit.
   */
  _onDropped() {
    this._fromRadio = null;
    this._toRadio = null;
    if (!this._wantConnected) {
      this._setStatus('offline');
      return;
    }
    const wait = BACKOFF[Math.min(this._attempt, BACKOFF.length - 1)];
    this._attempt++;
    this._setStatus('degraded', `link lost — retrying in ${Math.round(wait / 1000)}s`);
    this._scheduleRetry(wait);
  }

  /** @param {number} wait */
  _scheduleRetry(wait) {
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (!this._wantConnected) return;
      this._setStatus('connecting', 'reconnecting');
      this._attach().catch(() => {
        // Still out of range or still powered down. Keep trying: the whole
        // point is that walking back into range restores the link by itself.
        this._onDropped();
      });
    }, wait);
  }

  async disconnect() {
    this._wantConnected = false;
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    try {
      this._device?.gatt?.disconnect();
    } finally {
      this._device = null;
      this._fromRadio = null;
      this._toRadio = null;
      this._attempt = 0;
      this._setStatus('offline');
    }
  }

  /**
   * Read frames until the radio's queue is empty.
   *
   * Guarded against re-entry: notifications can arrive while a drain is still
   * running, and overlapping GATT reads on the same characteristic fail.
   */
  async _drain() {
    if (this._draining || !this._fromRadio) return;
    this._draining = true;
    try {
      for (;;) {
        if (!this._fromRadio) break;      // dropped mid-drain
        const value = await this._fromRadio.readValue();
        if (value.byteLength === 0) break;
        const frame = new Uint8Array(
          value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
        try {
          const pos = decodeFromRadio(frame);
          if (pos) this._emit(pos);
        } catch (err) {
          // A malformed frame must not kill the read loop.
          console.warn('frame decode failed', err);
        }
      }
    } catch (err) {
      // A read failure usually means the link went away; the disconnect event
      // handles recovery, so do not duplicate the retry here.
      if (this._wantConnected && this._fromRadio) {
        this._setStatus('degraded', err instanceof Error ? err.message : String(err));
      }
    } finally {
      this._draining = false;
    }
  }
}
