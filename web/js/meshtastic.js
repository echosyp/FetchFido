// @ts-check
/**
 * Meshtastic protocol decoding -- only the subset FetchFido needs.
 *
 * Path: FromRadio -> MeshPacket -> Data(portnum=POSITION_APP) -> Position.
 * Everything else is skipped. Decoding a narrow subset by hand is what lets
 * this app ship with no dependency tree; see docs/DESIGN.md section 3.1.
 *
 * Field numbers below were transcribed from the Meshtastic protobuf schema and
 * CONFIRMED against real firmware on 2026-08-02 over the HTTP transport:
 * decoded coordinates, RSSI, SNR, hop count and satellite count all matched
 * the same packets observed independently via MQTT.
 *
 * ground_speed and ground_track confirmed 2026-08-02 from a 300-fix export:
 * heading produced 163 distinct values all within 0-358.58 degrees, and speed
 * whole numbers 0-5. Every field in the position path is now verified.
 *
 * Still unconfirmed: everything in the BLE block below, and the serial framing
 * -- only the HTTP path has been exercised against hardware.
 */

import { Reader, WIRE, putVarint, putField } from './protobuf.js';

/**
 * Meshtastic BLE GATT service and characteristics.
 * [verify] -- the BLE path has not yet been run against hardware.
 */
export const BLE = {
  SERVICE: '6ba1b218-15a8-461f-9fa8-5dcae273eafd',
  TO_RADIO: 'f75c76d2-129e-4dad-a1dd-7866124401e7',
  FROM_RADIO: '2c55e69e-4993-11ed-b878-0242ac120002',
  FROM_NUM: 'ed9da18c-a800-4f66-a670-aa7547e34453',
};

export const PORTNUM = {
  POSITION_APP: 3,
  NODEINFO_APP: 4,
};

/** FromRadio field numbers. */
const FROM_RADIO = {
  PACKET: 2,
  NODE_INFO: 4,
  CONFIG_COMPLETE_ID: 7,
};

/** NodeInfo field numbers. */
const NODE_INFO = {
  NUM: 1,
  USER: 2,
  POSITION: 3,
  SNR: 4,
  LAST_HEARD: 5,
  HOPS_AWAY: 9,
};

/** User field numbers. */
const USER = {
  ID: 1,
  LONG_NAME: 2,
  SHORT_NAME: 3,
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

/** Position field numbers. All confirmed against real firmware. */
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
 * @property {'mesh'|'nodedb'} link  'nodedb' is a last-known position from the
 *   node database rather than a packet heard live; it may be considerably old
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
 * Decode diagnostics.
 *
 * Silence is the enemy here: a position that fails to decode looks exactly
 * like no traffic at all. These counters distinguish "nothing is arriving"
 * from "packets arrive but are encrypted" from "positions arrive but do not
 * parse" -- three problems with completely different fixes.
 */
export const diag = {
  /** Response bodies with content. */
  bodies: 0,
  /** MeshPackets seen inside them. */
  packets: 0,
  /** Packets the radio could not decrypt for us. */
  encrypted: 0,
  /** portnum -> count. */
  portnums: /** @type {Map<number, number>} */ (new Map()),
  /** Positions successfully decoded. */
  positions: 0,
  /** POSITION_APP payloads that failed to yield coordinates. */
  failures: 0,
  /** Hex of the most recent failing position payload, for reporting. */
  lastFailureHex: /** @type {string|null} */ (null),
};

/** @param {Uint8Array} b */
function hex(b) {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * @typedef {object} NodeName
 * @property {string} long   e.g. "Fido Collar 1"
 * @property {string} short  e.g. "FID1"
 */

/**
 * Friendly names, keyed by node ID ("!9ea0eaac").
 *
 * Populated from two sources: the NodeInfo batch the radio sends during the
 * config handshake, and live NODEINFO_APP packets. Node IDs remain the stable
 * key everywhere -- names are display sugar and can change or be absent.
 * @type {Map<string, NodeName>}
 */
export const nodeNames = new Map();

const utf8 = new TextDecoder();

/**
 * @typedef {object} NodeStatus
 * @property {number} lastHeard  epoch seconds the node was last heard at all
 * @property {number|null} snr
 * @property {number|null} hops
 * @property {boolean} hasPosition
 */

/**
 * Every node the radio knows about, whether or not it has a position.
 *
 * A collar can be transmitting clearly and still have no GPS fix -- indoors,
 * under cover, or after a config reset drops its almanac. Tracking only
 * positions makes that node vanish from the UI, which is indistinguishable
 * from a collar that is out of range or switched off. Those call for opposite
 * responses, so the two states must be told apart.
 * @type {Map<string, NodeStatus>}
 */
export const nodeStatus = new Map();

/**
 * Record that a node was heard.
 * @param {string} id
 * @param {Partial<NodeStatus>} patch
 */
function markHeard(id, patch) {
  const prev = nodeStatus.get(id);
  nodeStatus.set(id, {
    lastHeard: 0, snr: null, hops: null, hasPosition: false,
    ...prev,
    ...patch,
  });
}

/** @type {((id: string, name: NodeName) => void)[]} */
const nameCbs = [];

/**
 * Observe names as they are learned, so they can be persisted. Names arrive
 * only in a handshake or a NODEINFO_APP packet; without saving them the app
 * shows raw node IDs after every reload until it reconnects.
 * @param {(id: string, name: NodeName) => void} cb
 */
export function onNodeName(cb) {
  nameCbs.push(cb);
}

/**
 * Seed names from storage at startup.
 * @param {string} id
 * @param {NodeName} name
 */
export function primeNodeName(id, name) {
  nodeNames.set(id, name);
}

/**
 * Best available label for a node: long name, else short name, else the ID.
 * @param {string} deviceId
 * @returns {string}
 */
export function labelFor(deviceId) {
  const n = nodeNames.get(deviceId);
  return n?.long || n?.short || deviceId;
}

/**
 * Parse a User message and record its names.
 * @param {Uint8Array} buf
 * @param {string} [fallbackId] used when the message carries no id of its own
 */
function readUser(buf, fallbackId) {
  /** @type {string|null} */ let id = null;
  let long = '';
  let short = '';

  new Reader(buf).each((field, wire, r) => {
    if (wire !== WIRE.LEN) return false;
    switch (field) {
      case USER.ID: id = utf8.decode(r.bytes()); return true;
      case USER.LONG_NAME: long = utf8.decode(r.bytes()); return true;
      case USER.SHORT_NAME: short = utf8.decode(r.bytes()); return true;
      default: return false;
    }
  });

  const key = id || fallbackId;
  if (key && (long || short)) {
    const prev = nodeNames.get(key);
    if (!prev || prev.long !== long || prev.short !== short) {
      const name = { long, short };
      nodeNames.set(key, name);
      for (const cb of nameCbs) cb(key, name);
    }
  }
}

/**
 * Parse a NodeInfo message from the config handshake.
 *
 * NodeInfo carries each known node's **last known position**, which is what
 * the official Meshtastic client plots. Live POSITION_APP packets only arrive
 * when a node happens to broadcast, so on a quiet mesh they may not come for
 * many minutes -- ignoring the node database makes the app look dead while
 * every other client shows the fleet.
 *
 * These positions can be old. They are returned like any other so the UI's
 * existing age handling degrades them honestly.
 *
 * @param {Uint8Array} buf
 * @returns {Position|null}
 */
function readNodeInfo(buf) {
  let num = 0;
  /** @type {Uint8Array|null} */ let user = null;
  /** @type {Uint8Array|null} */ let position = null;
  /** @type {number|null} */ let snr = null;
  let lastHeard = 0;
  /** @type {number|null} */ let hopsAway = null;

  new Reader(buf).each((field, wire, r) => {
    switch (field) {
      case NODE_INFO.NUM:
        num = wire === WIRE.I32 ? r.u32() : r.varint();
        return true;
      case NODE_INFO.USER:
        if (wire === WIRE.LEN) { user = r.bytes(); return true; }
        return false;
      case NODE_INFO.POSITION:
        if (wire === WIRE.LEN) { position = r.bytes(); return true; }
        return false;
      case NODE_INFO.SNR:
        if (wire === WIRE.I32) { snr = r.f32(); return true; }
        return false;
      case NODE_INFO.LAST_HEARD:
        lastHeard = wire === WIRE.I32 ? r.u32() : r.varint();
        return true;
      case NODE_INFO.HOPS_AWAY:
        if (wire === WIRE.VARINT) { hopsAway = r.varint(); return true; }
        return false;
      default:
        return false;
    }
  });

  const id = num ? nodeId(num) : undefined;
  if (user) readUser(user, id);
  if (!id) return null;

  const pos = position ? decodePosition(position) : null;

  markHeard(id, {
    lastHeard: lastHeard || Math.floor(Date.now() / 1000),
    snr,
    hops: hopsAway,
    hasPosition: !!pos,
  });

  if (!pos) return null;

  diag.positions++;
  return {
    deviceId: id,
    // The position's own GPS stamp is best; last_heard is when the node was
    // last seen at all, which is a reasonable fallback.
    ts: pos.time || lastHeard || Math.floor(Date.now() / 1000),
    lat: pos.lat,
    lon: pos.lon,
    alt: pos.alt,
    speed: pos.speed,
    heading: pos.heading,
    sats: pos.sats,
    rssi: null,
    snr,
    hops: hopsAway,
    link: 'nodedb',
  };
}

export function resetDiag() {
  diag.bodies = 0;
  diag.packets = 0;
  diag.encrypted = 0;
  diag.portnums.clear();
  diag.positions = 0;
  diag.failures = 0;
  diag.lastFailureHex = null;
}

/**
 * Decode a response body into every position it contains.
 *
 * A body may hold SEVERAL FromRadio messages concatenated back to back -- the
 * HTTP API returns the whole queue in one response, and a config handshake
 * alone produces around fifty of them. Protobuf concatenation is itself valid
 * protobuf, so this parses as one message with repeated fields; the important
 * part is collecting every `packet` rather than keeping only the last, which
 * would silently drop all but one position per poll.
 *
 * @param {Uint8Array} body
 * @returns {Position[]}
 */
export function decodeFrames(body) {
  /** @type {Uint8Array[]} */
  const packets = [];
  /** @type {Position[]} */
  const fromDb = [];

  if (body.byteLength > 0) diag.bodies++;

  new Reader(body).each((field, wire, r) => {
    if (field === FROM_RADIO.PACKET && wire === WIRE.LEN) {
      packets.push(r.bytes());
      return true;
    }
    // The handshake delivers the node database: names AND each node's last
    // known position. Both are harvested, so the fleet appears immediately
    // rather than only once a node happens to broadcast.
    if (field === FROM_RADIO.NODE_INFO && wire === WIRE.LEN) {
      try {
        const p = readNodeInfo(r.bytes());
        if (p) fromDb.push(p);
      } catch (err) {
        console.warn('node info decode failed', err);
      }
      return true;
    }
    return false;
  });

  diag.packets += packets.length;

  /** @type {Position[]} */
  const out = [];
  for (const p of packets) {
    let pos = null;
    try {
      pos = decodeMeshPacket(p);
    } catch (err) {
      // One malformed packet must not discard the rest of the batch.
      console.warn('packet decode failed', err);
    }
    if (pos) out.push(pos);
  }
  return [...fromDb, ...out];
}

/**
 * Decode a body expected to hold a single position. Retained for the BLE
 * path, where the radio delivers one frame per read.
 * @param {Uint8Array} frame
 * @returns {Position|null}
 */
export function decodeFromRadio(frame) {
  const all = decodeFrames(frame);
  return all.length ? all[0] : null;
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

  // hop_start counts down to hop_limit as a packet is relayed, so the
  // difference is hops actually traversed. Zero means heard direct.
  const hops = (hopStart !== null && hopLimit !== null)
    ? Math.max(0, hopStart - hopLimit)
    : null;

  // Hearing anything at all from a node is meaningful, even a payload we do
  // not use -- it distinguishes "no GPS fix" from "gone".
  markHeard(nodeId(from), {
    lastHeard: rxTime || Math.floor(Date.now() / 1000),
    snr,
    hops,
  });

  if (!decoded) {
    // Encrypted, or a payload the radio could not open for us.
    diag.encrypted++;
    return null;
  }

  const { portnum, payload } = decodeData(decoded);
  if (portnum >= 0) diag.portnums.set(portnum, (diag.portnums.get(portnum) || 0) + 1);

  // Live name announcements: a node renaming itself, or one that joined after
  // the handshake and so was absent from the node database.
  if (portnum === PORTNUM.NODEINFO_APP && payload) {
    try {
      readUser(payload, nodeId(from));
    } catch (err) {
      console.warn('user decode failed', err);
    }
    return null;
  }

  if (portnum !== PORTNUM.POSITION_APP || !payload) return null;

  const pos = decodePosition(payload);
  if (!pos) {
    // A position payload that yields no coordinates means the field numbers
    // or wire types here do not match this firmware. Keep the bytes so the
    // problem can be diagnosed instead of guessed at.
    diag.failures++;
    diag.lastFailureHex = hex(payload);
    return null;
  }
  diag.positions++;

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
 * Unwrap Data into its portnum and payload.
 * @param {Uint8Array} buf
 * @returns {{portnum: number, payload: Uint8Array|null}}
 */
function decodeData(buf) {
  let portnum = -1;
  /** @type {Uint8Array|null} */ let payload = null;

  new Reader(buf).each((field, wire, r) => {
    if (field === DATA.PORTNUM && wire === WIRE.VARINT) { portnum = r.varint(); return true; }
    if (field === DATA.PAYLOAD && wire === WIRE.LEN) { payload = r.bytes(); return true; }
    return false;
  });

  return { portnum, payload };
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
      // Schema says sfixed32, but accept a varint encoder too. Guessing wrong
      // about the wire type would drop the coordinate silently, and tolerating
      // both costs nothing.
      case POSITION.LATITUDE_I:
        latI = wire === WIRE.I32 ? r.i32() : wire === WIRE.VARINT ? r.int32() : null;
        return latI !== null;
      case POSITION.LONGITUDE_I:
        lonI = wire === WIRE.I32 ? r.i32() : wire === WIRE.VARINT ? r.int32() : null;
        return lonI !== null;
      case POSITION.ALTITUDE:
        if (wire === WIRE.VARINT) { alt = r.int32(); return true; }
        if (wire === WIRE.I32) { alt = r.i32(); return true; }
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
