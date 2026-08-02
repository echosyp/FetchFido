// @ts-check
/**
 * Shared callback plumbing for CollarSource implementations.
 *
 * Every transport needs the same listener bookkeeping; only connect(),
 * disconnect() and available() differ.
 */

/** @typedef {import('../meshtastic.js').Position} Position */
/** @typedef {import('./types.js').SourceStatus} SourceStatus */

export class BaseSource {
  /** @param {string} name */
  constructor(name) {
    this.name = name;
    /** @type {SourceStatus} */
    this._status = 'offline';
    /** @type {((p: Position) => void)[]} */
    this._posCbs = [];
    /** @type {((s: SourceStatus, detail?: string) => void)[]} */
    this._statusCbs = [];
  }

  status() {
    return this._status;
  }

  /** @param {(p: Position) => void} cb */
  onPosition(cb) {
    this._posCbs.push(cb);
  }

  /** @param {(s: SourceStatus, detail?: string) => void} cb */
  onStatus(cb) {
    this._statusCbs.push(cb);
  }

  /** @param {Position} p */
  _emit(p) {
    for (const cb of this._posCbs) cb(p);
  }

  /**
   * @param {SourceStatus} s
   * @param {string} [detail]
   */
  _setStatus(s, detail) {
    this._status = s;
    for (const cb of this._statusCbs) cb(s, detail);
  }
}
