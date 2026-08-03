// @ts-check
/**
 * Device compass heading.
 *
 * Needed because a geographic bearing ("the dog is at 47 degrees") cannot be
 * turned into a physical direction without knowing which way the phone is
 * pointing. With a compass the arrow points at the dog; without one it can
 * only be drawn north-up, which is still usable but requires the user to
 * orient themselves.
 *
 * Three complications, all handled here:
 *  - iOS exposes `webkitCompassHeading`; everyone else exposes `alpha` on the
 *    `deviceorientationabsolute` event, measured the opposite way round.
 *  - iOS 13+ requires an explicit permission grant from a user gesture.
 *  - Some devices only ever report *relative* orientation, which is useless as
 *    a compass and must be rejected rather than silently pointed wrong.
 */

export class Compass {
  constructor() {
    /** Degrees clockwise from north, or null when unknown. */
    this.heading = /** @type {number|null} */ (null);
    /** @type {((h: number|null) => void)[]} */
    this._cbs = [];
    this._listening = false;
    this._handler = /** @type {((e: DeviceOrientationEvent) => void)|null} */ (null);
    /** Set when events arrive but carry no absolute reference. */
    this.relativeOnly = false;
  }

  available() {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  }

  /** iOS 13+ gates orientation behind an explicit grant. */
  needsPermission() {
    return this.available() &&
      typeof (/** @type {any} */ (window.DeviceOrientationEvent).requestPermission) === 'function';
  }

  /** @param {(h: number|null) => void} cb */
  onChange(cb) {
    this._cbs.push(cb);
  }

  /**
   * Begin listening. Call from a user gesture so the iOS prompt can appear.
   * @returns {Promise<boolean>} whether a usable compass is running
   */
  async start() {
    if (!this.available() || this._listening) return this._listening;

    if (this.needsPermission()) {
      const res = await /** @type {any} */ (window.DeviceOrientationEvent).requestPermission();
      if (res !== 'granted') return false;
    }

    this._handler = (e) => this._onEvent(e);
    // `deviceorientationabsolute` is the one referenced to true/magnetic north.
    // Plain `deviceorientation` is absolute on iOS but often relative elsewhere.
    const type = 'ondeviceorientationabsolute' in window
      ? 'deviceorientationabsolute'
      : 'deviceorientation';
    window.addEventListener(type, this._handler, true);
    this._listening = true;
    return true;
  }

  stop() {
    if (this._handler) {
      window.removeEventListener('deviceorientationabsolute', this._handler, true);
      window.removeEventListener('deviceorientation', this._handler, true);
    }
    this._handler = null;
    this._listening = false;
    this.heading = null;
    this._notify();
  }

  /** @param {DeviceOrientationEvent} e */
  _onEvent(e) {
    const webkit = /** @type {any} */ (e).webkitCompassHeading;

    let h = null;
    if (typeof webkit === 'number' && !Number.isNaN(webkit)) {
      // iOS: already degrees clockwise from north.
      h = webkit;
    } else if (e.absolute && typeof e.alpha === 'number') {
      // Standard: alpha runs anticlockwise from north, so invert it.
      h = (360 - e.alpha) % 360;
    } else if (typeof e.alpha === 'number') {
      // Relative orientation only -- no north reference, so refuse it rather
      // than draw an arrow that points somewhere arbitrary.
      this.relativeOnly = true;
      h = null;
    }

    if (h !== this.heading) {
      this.heading = h;
      this._notify();
    }
  }

  _notify() {
    for (const cb of this._cbs) cb(this.heading);
  }
}
