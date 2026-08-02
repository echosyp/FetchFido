// @ts-check
/**
 * The CollarSource contract.
 *
 * The UI binds only to this interface and never learns which transport is
 * live -- that distinction belongs in a status indicator, not in application
 * logic (docs/DESIGN.md section 5.1). Implementations: BleSource today;
 * SerialSource, WifiSource and ServerSource to follow.
 */

/** @typedef {import('../meshtastic.js').Position} Position */

/** @typedef {'offline'|'connecting'|'connected'|'degraded'} SourceStatus */

/**
 * @typedef {object} CollarSource
 * @property {string} name
 * @property {() => boolean} available   Whether this transport can run here at all
 * @property {() => Promise<void>} connect
 * @property {() => Promise<void>} disconnect
 * @property {(cb: (p: Position) => void) => void} onPosition
 * @property {(cb: (s: SourceStatus, detail?: string) => void) => void} onStatus
 * @property {() => SourceStatus} status
 */

export {};
