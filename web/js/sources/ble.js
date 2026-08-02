// @ts-check
/**
 * Web Bluetooth transport to a Meshtastic node.
 *
 * Platform note: Web Bluetooth exists in Chrome on Android and desktop, and
 * NOT in Safari on iOS. iOS users need the WiFi transport instead
 * (docs/DESIGN.md section 5.1). Requires a secure context -- https, or
 * localhost during development.
 */

import { BLE, decodeFromRadio, wantConfig } from '../meshtastic.js';
import { BaseSource } from './base.js';

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
  }

  available() {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  /**
   * Must be called from a user gesture -- the browser will not show the
   * device chooser otherwise.
   */
  async connect() {
    if (!this.available()) throw new Error('Web Bluetooth unavailable in this browser');

    this._setStatus('connecting');
    try {
      this._device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [BLE.SERVICE] }],
        optionalServices: [BLE.SERVICE],
      });

      this._device.addEventListener('gattserverdisconnected', () => {
        this._setStatus('offline', 'radio disconnected');
      });

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

      this._setStatus('connected', this._device.name || 'radio');
      await this._drain();
    } catch (err) {
      this._setStatus('offline', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async disconnect() {
    try {
      this._device?.gatt?.disconnect();
    } finally {
      this._device = null;
      this._fromRadio = null;
      this._toRadio = null;
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
      this._setStatus('degraded', err instanceof Error ? err.message : String(err));
    } finally {
      this._draining = false;
    }
  }
}
