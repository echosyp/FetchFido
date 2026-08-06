// @ts-check
/**
 * Screen wake lock.
 *
 * A phone that locks its screen suspends timers and can drop the app's work
 * entirely. On a walk that means an unexplained hole in the track -- which
 * looks exactly like a radio range limit and would corrupt a range test.
 *
 * The lock is held only while connected to a radio, so the app never keeps a
 * screen alive for nothing.
 *
 * Requires a secure context. Absent on iOS Safari before 16.4 and on some
 * desktop browsers; failure is reported rather than thrown, since it degrades
 * the experience without breaking it.
 */

export class Awake {
  constructor() {
    /** @type {any} */
    this._lock = null;
    this._wanted = false;
    /** @type {((held: boolean, why?: string) => void)[]} */
    this._cbs = [];
    this._bound = false;
  }

  available() {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  /** @param {(held: boolean, why?: string) => void} cb */
  onChange(cb) {
    this._cbs.push(cb);
  }

  /** @param {boolean} held @param {string} [why] */
  _notify(held, why) {
    for (const cb of this._cbs) cb(held, why);
  }

  /** Hold the screen awake until release() is called. */
  async request() {
    this._wanted = true;
    this._bind();
    await this._acquire();
  }

  async _acquire() {
    if (!this.available() || this._lock || !this._wanted) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    try {
      this._lock = await (/** @type {any} */ (navigator).wakeLock.request('screen'));
      // The browser drops the lock on its own when the page is hidden; note it
      // so the visibility handler knows to take it again.
      this._lock.addEventListener('release', () => {
        this._lock = null;
        this._notify(false, 'released');
      });
      this._notify(true);
    } catch (err) {
      this._notify(false, err instanceof Error ? err.message : String(err));
    }
  }

  _bind() {
    if (this._bound || typeof document === 'undefined') return;
    this._bound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this._acquire();
    });
  }

  async release() {
    this._wanted = false;
    const lock = this._lock;
    this._lock = null;
    try {
      await lock?.release();
    } catch {
      // Already gone; nothing to do.
    }
    this._notify(false);
  }

  get held() {
    return this._lock !== null;
  }
}
