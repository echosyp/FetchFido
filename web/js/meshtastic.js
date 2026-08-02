// @ts-check
/**
 * Meshtastic protocol decoding -- only the subset FetchFido needs.
 *
 * Path: FromRadio -> MeshPacket -> Data(portnum=POSITION_APP) -> Position.
 * Everything else is skipped. Decoding a narrow subset by hand is what lets
 * this app ship with no dependency tree; see docs/DESIGN.md section 3.1.
 *
 * Field numbers below are transcribed from the Meshtastic protobuf schema.
 * They are stable in practice but are NOT verified against a live radio in
 * this build -- see [verify] markers. If positions decode as null while
 * packets arrive, suspect these first.
 */

import { Reader, WIRE, putVarint, putField } from './protobuf.js';

/** Meshtastic BLE GATT service and characteristics. [verify against firmware] */
export const BLE = {
  SERVICE: '6ba1b218-15a8-461f-9fa8-5dcae273eafd',
  TO_RADIO: 'f75c76d2-129e-4dad-a1dd-7866124401e7',
  FROM_RADIO: '2c55e69e-4993-11ed-b878-0242ac120002',
  FROM_NUM: 'ed9da18c-a800-4f66-a670-aa7547e34453',
};

export const PORTNUM = {
  POSITION_APP: 3,
};

/** FromRadio field numbers. */
const FROM_RADIO = {
  PACKET: 2,
  CONFIG_COMPLETE_ID: 7,
};

/** MeshPacket field numbers. */
const MESH_PACKET = {
  FROM: 1,
  TO: 2,
  CHANNEL: 3,
  DECODED: 4,
  ENCRYPTED: 5,
  ID: 6,
  RX_TIME: 7,
  RX_SNR: 8,
  HOP_LIMIT: 9,
  RX_RSSI: 12,
  HOP_START: 15,
};

/** Data field numbers. */
const DATA = {
  PORTNUM: 1,
  PAYLOAD: 2,
};

/** Position field numbers. [verify -- 1-4 are high confidence, 15/16 less so] */
const POSITION = {
  LATITUDE_I: 1,
  LONGITUDE_I: 2,
  ALTITUDE: 3,
  TIME: 4,
  GROUND_SPEED: 15,
  GROUND_TRACK: 16,
  SATS_IN_VIEW: 19,
};

/**
 * @typedef {object} Position
 * @property {string} deviceId   Node ID as "!a1b2c3d4"
 * @property {number} ts         Epoch seconds, GPS-derived where available
 * @property {number} lat
 * @property {number} lon
 * @property {number|null} alt   Metres
 * @property {number|null} speed Metres/sec
 * @property {number|null} heading Degrees true
 * @property {number|null} sats
 * @property {number|null} rssi  Field-test telemetry
 * @property {number|null} snr
 * @property {number|null} hops  Hops traversed, null if unknown
 * @property {'mesh'} link
 */

/**
 * Format a numeric node ID the way Meshtastic presents it.
 * @param {number} num
 * @returns {string}
 */
export function nodeId(num) {
  return '!' + (num >>> 0).toString(16).padStart(8, '0');
}

/**
 * Decode one FromRadio frame. Returns a Position when the frame carried one,
 * otherwise null -- the overwhelming majority of frames are something else.
 * @param {Uint8Array} frame
 * @returns {Position|null}
 */
export function decodeFromRadio(frame) {
  /** @type {Uint8Array|null} */
  let packet = null;

  new Reader(frame).each((field, wire, r) => {
    if (field === FROM_RADIO.PACKET && wire === WIRE.LEN) {
      packet = r.bytes();
      return true;
    }
    return false;
  });

  return packet ? decodeMeshPacket(packet) : null;
}

/**
 * @param {Uint8Array} buf
 * @returns {Position|null}
 */
function decodeMeshPacket(buf) {
  let from = 0;
  let rxTime = 0;
  /** @type {number|null} */ let rssi = null;
  /** @type {number|null} */ let snr = null;
  /** @type {number|null} */ let hopLimit = null;
  /** @type {number|null} */ let hopStart = null;
  /** @type {Uint8Array|null} */ let decoded = null;

  new Reader(buf).each((field, wire, r) => {
    switch (field) {
      case MESH_PACKET.FROM:
        // Schema says fixed32, but tolerate a varint encoder.
        from = wire === WIRE.I32 ? r.u32() : r.varint();
        return true;
      case MESH_PACKET.RX_TIME:
        rxTime = wire === WIRE.I32 ? r.u32() : r.varint();
        return true;
      case MESH_PACKET.RX_SNR:
        if (wire === WIRE.I32) { snr = r.f32(); return true; }
        return false;
      case MESH_PACKET.RX_RSSI:
        if (wire === WIRE.VARINT) { rssi = r.int32(); return true; }
        return false;
      case MESH_PACKET.HOP_LIMIT:
        if (wire === WIRE.VARINT) { hopLimit = r.varint(); return true; }
        return false;
      case MESH_PACKET.HOP_START:
        if (wire === WIRE.VARINT) { hopStart = r.varint(); return true; }
        return false;
      case MESH_PACKET.DECODED:
        if (wire === WIRE.LEN) { decoded = r.bytes(); return true; }
        return false;
      default:
        return false;
    }
  });

  if (!decoded) return null; // encrypted, or a payload the radio could not open

  const payload = decodeData(decoded);
  if (!payload) return null;

  const pos = decodePosition(payload);
  if (!pos) return null;

  // hop_start counts down to hop_limit as a packet is relayed, so the
  // difference is hops actually traversed. Zero means heard direct.
  const hops = (hopStart !== null && hopLimit !== null)
    ? Math.max(0, hopStart - hopLimit)
    : null;

  return {
    deviceId: nodeId(from),
    // Prefer the GPS-stamped time from inside the Position; fall back to the
    // radio's receive time. Never use the phone clock -- relay delay is real
    // and variable (docs/DESIGN.md section 5.4).
    ts: pos.time || rxTime || Math.floor(Date.now() / 1000),
    lat: pos.lat,
    lon: pos.lon,
    alt: pos.alt,
    speed: pos.speed,
    heading: pos.heading,
    sats: pos.sats,
    rssi,
    snr,
    hops,
    link: 'mesh',
  };
}

/**
 * Unwrap Data, returning the payload only when it is a position.
 * @param {Uint8Array} buf
 * @returns {Uint8Array|null}
 */
function decodeData(buf) {
  let portnum = -1;
  /** @type {Uint8Array|null} */ let payload = null;

  new Reader(buf).each((field, wire, r) => {
    if (field === DATA.PORTNUM && wire === WIRE.VARINT) { portnum = r.varint(); return true; }
    if (field === DATA.PAYLOAD && wire === WIRE.LEN) { payload = r.bytes(); return true; }
    return false;
  });

  return portnum === PORTNUM.POSITION_APP ? payload : null;
}

/**
 * @param {Uint8Array} buf
 * @returns {{lat:number, lon:number, alt:number|null, time:number,
 *            speed:number|null, heading:number|null, sats:number|null}|null}
 */
function decodePosition(buf) {
  /** @type {number|null} */ let latI = null;
  /** @type {number|null} */ let lonI = null;
  /** @type {number|null} */ let alt = null;
  let time = 0;
  /** @type {number|null} */ let speed = null;
  /** @type {number|null} */ let heading = null;
  /** @type {number|null} */ let sats = null;

  new Reader(buf).each((field, wire, r) => {
    switch (field) {
      case POSITION.LATITUDE_I:
        if (wire === WIRE.I32) { latI = r.i32(); return true; }
        return false;
      case POSITION.LONGITUDE_I:
        if (wire === WIRE.I32) { lonI = r.i32(); return true; }
        return false;
      case POSITION.ALTITUDE:
        if (wire === WIRE.VARINT) { alt = r.int32(); return true; }
        return false;
      case POSITION.TIME:
        time = wire === WIRE.I32 ? r.u32() : r.varint();
        return true;
      case POSITION.GROUND_SPEED:
        if (wire === WIRE.VARINT) { speed = r.varint(); return true; }
        return false;
      case POSITION.GROUND_TRACK:
        if (wire === WIRE.VARINT) { heading = r.varint() / 1e5; return true; }
        return false;
      case POSITION.SATS_IN_VIEW:
        if (wire === WIRE.VARINT) { sats = r.varint(); return true; }
        return false;
      default:
        return false;
    }
  });

  if (latI === null || lonI === null) return null;
  // A node with no GPS fix reports 0/0. That is a real coordinate in the Gulf
  // of Guinea, so it must be rejected rather than plotted.
  if (latI === 0 && lonI === 0) return null;

  const lat = latI / 1e7;
  const lon = lonI / 1e7;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  return { lat, lon, alt, time, speed, heading, sats };
}

/**
 * Build the ToRadio frame that starts a config handshake. The radio replies
 * with its node database and then streams live packets.
 * @param {number} configId
 * @returns {Uint8Array}
 */
export function wantConfig(configId) {
  // ToRadio.want_config_id is field 3, a varint.
  return new Uint8Array(putField(3, WIRE.VARINT, putVarint(configId >>> 0)));
}
