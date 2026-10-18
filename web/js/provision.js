// @ts-check
/**
 * Configure the connected Meshtastic node as a FetchFido collar on the public
 * mesh (docs/TODO.md item 1; docs/DESIGN.md section 4).
 *
 * A stock node becomes a tracker by changing a handful of settings: role,
 * position cadence, GPS on, the public channel, and a name. The official app
 * can do all of this by hand across five screens; this does it in one step,
 * which is what "anyone can use this" requires (docs/PRD.md section 3).
 *
 * Everything here is sent as AdminMessages over whatever transport is already
 * connected -- the same BLE, serial or WiFi link positions arrive on.
 *
 * Two properties of the protocol shape this file:
 *
 *  1. Configuration blocks are written whole. A set_config carrying only the
 *     role would zero every other DeviceConfig field, including ones this code
 *     does not know about. So each block is READ first, the few fields that
 *     matter are replaced, and the rest is sent back byte for byte
 *     (protobuf.js patchMessage). Firmware can add fields and this still does
 *     not clobber them.
 *
 *  2. Set commands carry a session passkey the node hands out with every
 *     get response (300 s expiry). Reads come first anyway, so the key is
 *     always fresh when the writes start.
 *
 * Field numbers below were taken from the published schema
 * (meshtastic/protobufs master, 2026-10-17). What the schema cannot tell us
 * is marked [verify] and needs one session against a real node.
 */

import {
  Reader, WIRE, putBytes, putString, putUint, putBool, putFixed32, patchMessage,
} from './protobuf.js';
import { PORTNUM, PRESET_NAMES, REGION_NAMES, nodeId } from './meshtastic.js';

/** @typedef {import('./meshtastic.js').AdminReply} AdminReply */

// ---- field numbers ---------------------------------------------------------

const TO_RADIO = { PACKET: 1 };
const MESH_PACKET = { TO: 2, DECODED: 4, ID: 6 };
const DATA = { PORTNUM: 1, PAYLOAD: 2, WANT_RESPONSE: 3 };

/** AdminMessage oneof members, plus the passkey that rides alongside. */
export const ADMIN = {
  GET_CHANNEL_REQUEST: 1,
  GET_CHANNEL_RESPONSE: 2,
  GET_OWNER_REQUEST: 3,
  GET_OWNER_RESPONSE: 4,
  GET_CONFIG_REQUEST: 5,
  GET_CONFIG_RESPONSE: 6,
  SET_OWNER: 32,
  SET_CHANNEL: 33,
  SET_CONFIG: 34,
  BEGIN_EDIT_SETTINGS: 64,
  COMMIT_EDIT_SETTINGS: 65,
  SESSION_PASSKEY: 101,
};

/** AdminMessage.ConfigType, the argument to get_config_request. */
export const CONFIG_TYPE = { DEVICE: 0, POSITION: 1, LORA: 5 };

/** Config oneof members. */
export const CONFIG = { DEVICE: 1, POSITION: 2, LORA: 6 };

const DEVICE_CONFIG = { ROLE: 1, SERIAL_ENABLED: 2, REBROADCAST_MODE: 6 };
export const ROLE = { CLIENT: 0, TRACKER: 5 };
/** NONE is only permitted for SENSOR, TRACKER and TAK_TRACKER roles. */
const REBROADCAST = { ALL: 0, NONE: 4 };

const POSITION_CONFIG = {
  BROADCAST_SECS: 1,
  SMART_ENABLED: 2,
  FIXED: 3,
  GPS_UPDATE_INTERVAL: 5,
  FLAGS: 7,
  SMART_MIN_DISTANCE: 10,
  SMART_MIN_INTERVAL: 11,
  GPS_MODE: 13,
};
export const GPS_MODE = { DISABLED: 0, ENABLED: 1, NOT_PRESENT: 2 };
const POSITION_FLAGS = { ALTITUDE: 0x1, SATINVIEW: 0x20, HEADING: 0x100, SPEED: 0x200 };

const LORA_CONFIG = { USE_PRESET: 1, MODEM_PRESET: 2, REGION: 7, HOP_LIMIT: 8, TX_ENABLED: 9 };

const CHANNEL = { INDEX: 1, SETTINGS: 2, ROLE: 3 };
export const CHANNEL_ROLE = { DISABLED: 0, PRIMARY: 1, SECONDARY: 2 };
const CHANNEL_SETTINGS = { PSK: 2, NAME: 3, MODULE_SETTINGS: 7 };
const MODULE_SETTINGS = { POSITION_PRECISION: 1 };

const USER = { LONG_NAME: 2, SHORT_NAME: 3, IS_UNMESSAGABLE: 9 };

// ---- what a collar on the public mesh looks like ----------------------------

/**
 * The public mesh is Meshtastic's default primary channel: LongFast with the
 * well-known default key, which the schema spells as the single byte 0x01.
 * The empty name means "named after the preset", which is how every stock
 * node ships, so a collar set up here lands on the same channel as the
 * community nodes that will relay it.
 *
 * position_precision 32 is full precision. Newer firmware and apps default
 * shared channels to a coarsened position for privacy; a collar whose fix is
 * rounded to a kilometre cannot find a dog. [verify] that 32 is accepted as
 * "no coarsening" by current firmware, rather than only 0.
 */
export const PUBLIC_MESH = Object.freeze({
  preset: PRESET_NAMES.indexOf('LongFast'),
  psk: [0x01],
  name: '',
  positionPrecision: 32,
});

/**
 * Cadence defaults from the airtime budget (docs/DESIGN.md section 3.2):
 * 30 s while moving, 300 s at rest, and a 30 m movement threshold because a
 * motionless node drifts 5.8 m median and 19.5 m p95 on its own.
 *
 * Mapped onto stock smart-position-broadcast: the periodic interval is the
 * at-rest cadence, and the smart minimum interval and distance gate the
 * moving case. Whether the firmware's threshold compares against a single
 * fix or something smoothed is the open question in section 3.2 [verify].
 *
 * gpsUpdateSecs caps how stale a fix can be when it is sent; it must not
 * exceed the moving interval or the collar reports where it was, not where
 * it is.
 */
export const DEFAULTS = Object.freeze({
  stationarySecs: 300,
  movingSecs: 30,
  moveThresholdM: 30,
  gpsUpdateSecs: 30,
});

/** Firmware buffers: long_name[40], short_name[5], both NUL terminated. */
const MAX_LONG_NAME_BYTES = 39;
const MAX_SHORT_NAME_BYTES = 4;

// ---- encoding --------------------------------------------------------------

/**
 * Wrap an AdminMessage in Data, MeshPacket and ToRadio, addressed to a node.
 *
 * The packet id is what ties a reply back to its request: the node echoes it
 * in Data.request_id. It must be set by us and non-zero, or there is nothing
 * to match on.
 *
 * @param {number} to node number
 * @param {number} id packet id, non-zero
 * @param {number[]} admin encoded AdminMessage
 * @param {boolean} wantResponse
 * @returns {Uint8Array}
 */
export function adminPacket(to, id, admin, wantResponse) {
  const data = [
    ...putUint(DATA.PORTNUM, PORTNUM.ADMIN_APP),
    ...putBytes(DATA.PAYLOAD, admin),
    ...(wantResponse ? putBool(DATA.WANT_RESPONSE, true) : []),
  ];
  const packet = [
    ...putFixed32(MESH_PACKET.TO, to),
    ...putBytes(MESH_PACKET.DECODED, data),
    ...putFixed32(MESH_PACKET.ID, id),
  ];
  return new Uint8Array(putBytes(TO_RADIO.PACKET, packet));
}

/**
 * @param {number[]} variant the oneof member, already encoded with its tag
 * @param {Uint8Array|null} passkey
 * @returns {number[]}
 */
function adminMessage(variant, passkey) {
  return passkey && passkey.length
    ? [...variant, ...putBytes(ADMIN.SESSION_PASSKEY, passkey)]
    : variant;
}

/** AdminMessage builders. Each returns an encoded AdminMessage. */
export const admin = {
  /** @param {number} type @param {Uint8Array|null} pk */
  getConfig: (type, pk) => adminMessage(putUint(ADMIN.GET_CONFIG_REQUEST, type), pk),
  /**
   * Channel index is sent plus one: zero would be read as "not present".
   * @param {number} index @param {Uint8Array|null} pk
   */
  getChannel: (index, pk) => adminMessage(putUint(ADMIN.GET_CHANNEL_REQUEST, index + 1), pk),
  /** @param {Uint8Array|null} pk */
  getOwner: (pk) => adminMessage(putBool(ADMIN.GET_OWNER_REQUEST, true), pk),
  /** @param {number[]} user @param {Uint8Array|null} pk */
  setOwner: (user, pk) => adminMessage(putBytes(ADMIN.SET_OWNER, user), pk),
  /** @param {number[]} channel @param {Uint8Array|null} pk */
  setChannel: (channel, pk) => adminMessage(putBytes(ADMIN.SET_CHANNEL, channel), pk),
  /** @param {number[]} config @param {Uint8Array|null} pk */
  setConfig: (config, pk) => adminMessage(putBytes(ADMIN.SET_CONFIG, config), pk),
  /** @param {Uint8Array|null} pk */
  beginEdit: (pk) => adminMessage(putBool(ADMIN.BEGIN_EDIT_SETTINGS, true), pk),
  /** @param {Uint8Array|null} pk */
  commitEdit: (pk) => adminMessage(putBool(ADMIN.COMMIT_EDIT_SETTINGS, true), pk),
};

/**
 * Split an AdminMessage into its oneof member and the passkey, if any.
 * @param {Uint8Array} payload
 * @returns {{variant: number, body: Uint8Array|number|null, passkey: Uint8Array|null}}
 */
export function decodeAdmin(payload) {
  let variant = 0;
  /** @type {Uint8Array|number|null} */ let body = null;
  /** @type {Uint8Array|null} */ let passkey = null;
  new Reader(payload).each((field, wire, r) => {
    if (field === ADMIN.SESSION_PASSKEY && wire === WIRE.LEN) { passkey = r.bytes(); return true; }
    if (wire === WIRE.LEN) { variant = field; body = r.bytes(); return true; }
    if (wire === WIRE.VARINT) { variant = field; body = r.varint(); return true; }
    return false;
  });
  return { variant, body, passkey };
}

/**
 * Which block a Config message carries, and its bytes.
 * @param {Uint8Array} config
 * @returns {{type: number, body: Uint8Array}|null}
 */
export function configVariant(config) {
  /** @type {{type: number, body: Uint8Array}|null} */ let out = null;
  new Reader(config).each((field, wire, r) => {
    if (wire !== WIRE.LEN) return false;
    out = { type: field, body: r.bytes() };
    return true;
  });
  return out;
}

// ---- the collar's settings, as patches over what the node has now -----------

/**
 * @param {Uint8Array} current encoded DeviceConfig
 * @returns {number[]} encoded Config{device}
 */
export function trackerDeviceConfig(current) {
  const device = patchMessage(current, {
    [DEVICE_CONFIG.ROLE]: putUint(DEVICE_CONFIG.ROLE, ROLE.TRACKER),
    // A collar 40 cm off the ground is a poor relay and relaying costs it
    // battery and the mesh airtime. NONE is allowed for the tracker role.
    [DEVICE_CONFIG.REBROADCAST_MODE]: putUint(DEVICE_CONFIG.REBROADCAST_MODE, REBROADCAST.NONE),
  });
  return putBytes(CONFIG.DEVICE, device);
}

/**
 * @param {Uint8Array} current encoded PositionConfig
 * @param {{stationarySecs: number, movingSecs: number, moveThresholdM: number, gpsUpdateSecs: number}} c
 * @returns {number[]} encoded Config{position}
 */
export function trackerPositionConfig(current, c) {
  // Only what the app renders: altitude, satellites, heading, speed. DOP and
  // the geoid separation cost bytes on every packet and nothing reads them.
  const flags = POSITION_FLAGS.ALTITUDE | POSITION_FLAGS.SATINVIEW |
    POSITION_FLAGS.HEADING | POSITION_FLAGS.SPEED;
  const position = patchMessage(current, {
    [POSITION_CONFIG.BROADCAST_SECS]: putUint(POSITION_CONFIG.BROADCAST_SECS, c.stationarySecs),
    [POSITION_CONFIG.SMART_ENABLED]: putBool(POSITION_CONFIG.SMART_ENABLED, true),
    // A collar is never a fixed-position node; a leftover flag here would pin
    // the dog to wherever the radio was configured.
    [POSITION_CONFIG.FIXED]: putBool(POSITION_CONFIG.FIXED, false),
    [POSITION_CONFIG.GPS_UPDATE_INTERVAL]: putUint(POSITION_CONFIG.GPS_UPDATE_INTERVAL,
      Math.min(c.gpsUpdateSecs, c.movingSecs)),
    [POSITION_CONFIG.FLAGS]: putUint(POSITION_CONFIG.FLAGS, flags),
    [POSITION_CONFIG.SMART_MIN_DISTANCE]: putUint(POSITION_CONFIG.SMART_MIN_DISTANCE, c.moveThresholdM),
    [POSITION_CONFIG.SMART_MIN_INTERVAL]: putUint(POSITION_CONFIG.SMART_MIN_INTERVAL, c.movingSecs),
    [POSITION_CONFIG.GPS_MODE]: putUint(POSITION_CONFIG.GPS_MODE, GPS_MODE.ENABLED),
  });
  return putBytes(CONFIG.POSITION, position);
}

/**
 * @param {Uint8Array} current encoded LoRaConfig
 * @param {number} region RegionCode, non-zero
 * @returns {number[]} encoded Config{lora}
 */
export function trackerLoraConfig(current, region) {
  const lora = patchMessage(current, {
    [LORA_CONFIG.USE_PRESET]: putBool(LORA_CONFIG.USE_PRESET, true),
    [LORA_CONFIG.MODEM_PRESET]: putUint(LORA_CONFIG.MODEM_PRESET, PUBLIC_MESH.preset),
    [LORA_CONFIG.REGION]: putUint(LORA_CONFIG.REGION, region),
    // A node someone had muted would otherwise stay silent with a tracker
    // role and look exactly like one out of range.
    [LORA_CONFIG.TX_ENABLED]: putBool(LORA_CONFIG.TX_ENABLED, true),
  });
  return putBytes(CONFIG.LORA, lora);
}

/**
 * The primary channel, written fresh rather than patched: moving a node onto
 * the public mesh means replacing whatever private key it had.
 * @returns {number[]} encoded Channel
 */
export function publicChannel() {
  const settings = [
    ...putBytes(CHANNEL_SETTINGS.PSK, PUBLIC_MESH.psk),
    ...putString(CHANNEL_SETTINGS.NAME, PUBLIC_MESH.name),
    ...putBytes(CHANNEL_SETTINGS.MODULE_SETTINGS,
      putUint(MODULE_SETTINGS.POSITION_PRECISION, PUBLIC_MESH.positionPrecision)),
  ];
  return [
    ...putUint(CHANNEL.INDEX, 0),
    ...putBytes(CHANNEL.SETTINGS, settings),
    ...putUint(CHANNEL.ROLE, CHANNEL_ROLE.PRIMARY),
  ];
}

/**
 * The owner record: the dog's name. Firmware merges set_owner field by field,
 * so only names are sent and the node keeps its hardware model and keys.
 *
 * Marked unmessagable so other apps on the mesh do not offer to chat with a
 * dog. Older firmware ignores the field.
 *
 * @param {string} longName
 * @param {string} shortName
 * @returns {number[]} encoded User
 */
export function collarOwner(longName, shortName) {
  return [
    ...putString(USER.LONG_NAME, longName),
    ...putString(USER.SHORT_NAME, shortName),
    ...putBool(USER.IS_UNMESSAGABLE, true),
  ];
}

/**
 * Check the names fit the firmware's buffers. Returns the trimmed pair.
 * @param {string} longName
 * @param {string} shortName
 * @returns {{longName: string, shortName: string}}
 */
export function validateNames(longName, shortName) {
  const enc = new TextEncoder();
  const l = (longName || '').trim();
  const s = (shortName || '').trim();
  if (!l) throw new Error('a name is required');
  if (enc.encode(l).length > MAX_LONG_NAME_BYTES) {
    throw new Error(`name is too long (max ${MAX_LONG_NAME_BYTES} bytes)`);
  }
  if (!s) throw new Error('a short name is required');
  if (enc.encode(s).length > MAX_SHORT_NAME_BYTES) {
    throw new Error(`short name is too long (max ${MAX_SHORT_NAME_BYTES} bytes)`);
  }
  return { longName: l, shortName: s };
}

// ---- reading back ----------------------------------------------------------

/** @param {Uint8Array} buf @returns {{role: number, serialEnabled: boolean|null, rebroadcastMode: number}} */
export function readDeviceConfig(buf) {
  const out = { role: 0, serialEnabled: /** @type {boolean|null} */ (null), rebroadcastMode: 0 };
  new Reader(buf).each((field, wire, r) => {
    if (wire !== WIRE.VARINT) return false;
    switch (field) {
      case DEVICE_CONFIG.ROLE: out.role = r.varint(); return true;
      case DEVICE_CONFIG.SERIAL_ENABLED: out.serialEnabled = r.varint() !== 0; return true;
      case DEVICE_CONFIG.REBROADCAST_MODE: out.rebroadcastMode = r.varint(); return true;
      default: return false;
    }
  });
  return out;
}

/**
 * @param {Uint8Array} buf
 * @returns {{broadcastSecs: number, smart: boolean, fixed: boolean, gpsUpdateSecs: number,
 *            flags: number, minDistanceM: number, minIntervalSecs: number, gpsMode: number}}
 */
export function readPositionConfig(buf) {
  const out = {
    broadcastSecs: 0, smart: false, fixed: false, gpsUpdateSecs: 0, flags: 0,
    minDistanceM: 0, minIntervalSecs: 0, gpsMode: 0,
  };
  new Reader(buf).each((field, wire, r) => {
    if (wire !== WIRE.VARINT) return false;
    switch (field) {
      case POSITION_CONFIG.BROADCAST_SECS: out.broadcastSecs = r.varint(); return true;
      case POSITION_CONFIG.SMART_ENABLED: out.smart = r.varint() !== 0; return true;
      case POSITION_CONFIG.FIXED: out.fixed = r.varint() !== 0; return true;
      case POSITION_CONFIG.GPS_UPDATE_INTERVAL: out.gpsUpdateSecs = r.varint(); return true;
      case POSITION_CONFIG.FLAGS: out.flags = r.varint(); return true;
      case POSITION_CONFIG.SMART_MIN_DISTANCE: out.minDistanceM = r.varint(); return true;
      case POSITION_CONFIG.SMART_MIN_INTERVAL: out.minIntervalSecs = r.varint(); return true;
      case POSITION_CONFIG.GPS_MODE: out.gpsMode = r.varint(); return true;
      default: return false;
    }
  });
  return out;
}

/** @param {Uint8Array} buf @returns {{usePreset: boolean, preset: number, region: number, hopLimit: number, txEnabled: boolean}} */
export function readLoraConfig(buf) {
  const out = { usePreset: false, preset: 0, region: 0, hopLimit: 0, txEnabled: false };
  new Reader(buf).each((field, wire, r) => {
    if (wire !== WIRE.VARINT) return false;
    switch (field) {
      case LORA_CONFIG.USE_PRESET: out.usePreset = r.varint() !== 0; return true;
      case LORA_CONFIG.MODEM_PRESET: out.preset = r.varint(); return true;
      case LORA_CONFIG.REGION: out.region = r.varint(); return true;
      case LORA_CONFIG.HOP_LIMIT: out.hopLimit = r.varint(); return true;
      case LORA_CONFIG.TX_ENABLED: out.txEnabled = r.varint() !== 0; return true;
      default: return false;
    }
  });
  return out;
}

/** @param {Uint8Array} buf @returns {{index: number, role: number, psk: number[], name: string, precision: number|null}} */
export function readChannel(buf) {
  const out = { index: 0, role: 0, psk: /** @type {number[]} */ ([]), name: '', precision: /** @type {number|null} */ (null) };
  new Reader(buf).each((field, wire, r) => {
    if (field === CHANNEL.INDEX && wire === WIRE.VARINT) { out.index = r.varint(); return true; }
    if (field === CHANNEL.ROLE && wire === WIRE.VARINT) { out.role = r.varint(); return true; }
    if (field === CHANNEL.SETTINGS && wire === WIRE.LEN) {
      new Reader(r.bytes()).each((f, w, rr) => {
        if (f === CHANNEL_SETTINGS.PSK && w === WIRE.LEN) { out.psk = Array.from(rr.bytes()); return true; }
        if (f === CHANNEL_SETTINGS.NAME && w === WIRE.LEN) { out.name = new TextDecoder().decode(rr.bytes()); return true; }
        if (f === CHANNEL_SETTINGS.MODULE_SETTINGS && w === WIRE.LEN) {
          new Reader(rr.bytes()).each((mf, mw, mr) => {
            if (mf === MODULE_SETTINGS.POSITION_PRECISION && mw === WIRE.VARINT) { out.precision = mr.varint(); return true; }
            return false;
          });
          return true;
        }
        return false;
      });
      return true;
    }
    return false;
  });
  return out;
}

// ---- the procedure ---------------------------------------------------------

/**
 * @typedef {object} Link
 * @property {(bytes: Uint8Array) => Promise<void>} send      one ToRadio message
 * @property {(cb: (reply: AdminReply) => void) => () => void} onAdmin  subscribe to replies
 * @property {() => number|null} myNodeNum  the connected node's number, once known
 */

/**
 * @typedef {object} Options
 * @property {string} longName   the dog's name
 * @property {string} shortName  up to four characters
 * @property {number} [region]   RegionCode; omitted keeps the node's current one
 * @property {number} [stationarySecs]
 * @property {number} [movingSecs]
 * @property {number} [moveThresholdM]
 * @property {number} [timeoutMs]  per request
 */

/**
 * @typedef {'read'|'region'|'begin'|'owner'|'channel'|'device'|'position'|'lora'|'verify'|'commit'} Step
 * @typedef {(step: Step, state: 'run'|'ok'|'fail', detail?: string) => void} Report
 */

/**
 * @typedef {object} Outcome
 * @property {string} nodeId
 * @property {string} region
 * @property {string} preset
 * @property {{role: number, region: number, preset: number, channelName: string, pskLen: number}} before
 */

/**
 * Read the node's current settings, write the collar's over them, verify the
 * node now reports them, and commit. The commit makes the node save and
 * reboot, which drops the connection -- that is expected, and the caller's
 * status line will say so.
 *
 * Nothing is committed unless the read-back matches. A node that quietly
 * ignores a setting (older firmware, a locked-down admin channel) is reported
 * rather than left half configured.
 *
 * @param {Link} link
 * @param {Options} opts
 * @param {Report} [report]
 * @returns {Promise<Outcome>}
 */
export async function provisionTracker(link, opts, report = () => {}) {
  const names = validateNames(opts.longName, opts.shortName);
  const cadence = {
    stationarySecs: opts.stationarySecs ?? DEFAULTS.stationarySecs,
    movingSecs: opts.movingSecs ?? DEFAULTS.movingSecs,
    moveThresholdM: opts.moveThresholdM ?? DEFAULTS.moveThresholdM,
    gpsUpdateSecs: DEFAULTS.gpsUpdateSecs,
  };
  if (cadence.movingSecs < 10 || cadence.stationarySecs < cadence.movingSecs) {
    throw new Error('cadence: moving interval must be at least 10 s and no longer than the resting interval');
  }

  const to = link.myNodeNum();
  if (!to) throw new Error('the connected node has not identified itself yet — reconnect and try again');

  const session = new Session(link, to, opts.timeoutMs ?? 8000);

  // 1. Read everything that will be rewritten.
  report('read', 'run');
  const device = await session.getConfig(CONFIG_TYPE.DEVICE, CONFIG.DEVICE);
  const position = await session.getConfig(CONFIG_TYPE.POSITION, CONFIG.POSITION);
  const lora = await session.getConfig(CONFIG_TYPE.LORA, CONFIG.LORA);
  const channel = await session.getChannel(0);
  const before = {
    role: readDeviceConfig(device).role,
    region: readLoraConfig(lora).region,
    preset: readLoraConfig(lora).preset,
    channelName: readChannel(channel).name,
    pskLen: readChannel(channel).psk.length,
  };
  report('read', 'ok',
    `role ${before.role}, ${REGION_NAMES[before.region] || 'region ' + before.region}, ` +
    `${PRESET_NAMES[before.preset] || 'preset ' + before.preset}, ` +
    `channel "${before.channelName || 'default'}"`);

  // 2. Region. A node with no region does not transmit at all, and we must
  // not guess one: the wrong band is illegal and also deaf to the mesh.
  report('region', 'run');
  const region = opts.region || before.region;
  if (!region) {
    report('region', 'fail', 'the node has no region set and none was chosen');
    throw new Error('choose a region: the node has none set');
  }
  report('region', 'ok', REGION_NAMES[region] || `region ${region}`);

  // 3. Write inside a transaction so the node saves and reboots once at the
  // end rather than after each block.
  report('begin', 'run');
  await session.set(admin.beginEdit(session.passkey));
  report('begin', 'ok');

  const steps = /** @type {[Step, number[]][]} */ ([
    ['owner', admin.setOwner(collarOwner(names.longName, names.shortName), session.passkey)],
    ['channel', admin.setChannel(publicChannel(), session.passkey)],
    ['device', admin.setConfig(trackerDeviceConfig(device), session.passkey)],
    ['position', admin.setConfig(trackerPositionConfig(position, cadence), session.passkey)],
    ['lora', admin.setConfig(trackerLoraConfig(lora, region), session.passkey)],
  ]);
  for (const [step, msg] of steps) {
    report(step, 'run');
    await session.set(msg);
    report(step, 'ok');
  }

  // 4. Read back before committing. Within the transaction the node answers
  // from its in-memory config, so what it reports now is what commit saves.
  report('verify', 'run');
  const d = readDeviceConfig(await session.getConfig(CONFIG_TYPE.DEVICE, CONFIG.DEVICE));
  const p = readPositionConfig(await session.getConfig(CONFIG_TYPE.POSITION, CONFIG.POSITION));
  const l = readLoraConfig(await session.getConfig(CONFIG_TYPE.LORA, CONFIG.LORA));
  const ch = readChannel(await session.getChannel(0));
  const problems = [];
  if (d.role !== ROLE.TRACKER) problems.push(`role is ${d.role}, not tracker`);
  if (!p.smart) problems.push('smart position broadcast is off');
  if (p.gpsMode !== GPS_MODE.ENABLED) problems.push(`GPS mode is ${p.gpsMode}, not enabled`);
  if (p.minIntervalSecs !== cadence.movingSecs) problems.push(`moving interval is ${p.minIntervalSecs} s`);
  if (p.broadcastSecs !== cadence.stationarySecs) problems.push(`resting interval is ${p.broadcastSecs} s`);
  if (l.region !== region) problems.push(`region is ${REGION_NAMES[l.region] || l.region}`);
  if (!l.usePreset || l.preset !== PUBLIC_MESH.preset) problems.push(`preset is ${PRESET_NAMES[l.preset] || l.preset}`);
  if (!l.txEnabled) problems.push('transmit is disabled');
  if (ch.role !== CHANNEL_ROLE.PRIMARY) problems.push('channel 0 is not primary');
  if (ch.psk.length !== 1 || ch.psk[0] !== PUBLIC_MESH.psk[0]) problems.push('channel key is not the public default');
  if (ch.precision !== null && ch.precision !== PUBLIC_MESH.positionPrecision) {
    problems.push(`position precision is ${ch.precision} bits`);
  }
  if (problems.length) {
    report('verify', 'fail', problems.join('; '));
    throw new Error('the node did not take the settings: ' + problems.join('; ') +
      '. Nothing was committed.');
  }
  report('verify', 'ok', 'node reports every setting as written');

  // 5. Commit: the node saves to flash and reboots into the new role.
  report('commit', 'run');
  await session.set(admin.commitEdit(session.passkey));
  report('commit', 'ok', 'saved — the node is rebooting and will drop this link');

  return {
    nodeId: nodeId(to),
    region: REGION_NAMES[region] || String(region),
    preset: PRESET_NAMES[PUBLIC_MESH.preset],
    before,
  };
}

/**
 * One configuration conversation with one node: request/reply matching by
 * packet id, and the rolling session passkey.
 */
class Session {
  /**
   * @param {Link} link
   * @param {number} to
   * @param {number} timeoutMs
   */
  constructor(link, to, timeoutMs) {
    this.link = link;
    this.to = to;
    this.timeoutMs = timeoutMs;
    /** @type {Uint8Array|null} */
    this.passkey = null;
  }

  /** @returns {number} a non-zero 32-bit packet id */
  static id() {
    return Math.floor(Math.random() * 0xfffffffe) + 1;
  }

  /**
   * Send an AdminMessage that expects a reply, and wait for it.
   * @param {number[]} msg
   * @param {number} wantVariant the reply's oneof member
   * @returns {Promise<Uint8Array>}
   */
  request(msg, wantVariant) {
    const id = Session.id();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`no reply from the node within ${this.timeoutMs / 1000}s — ` +
          'admin messages may be blocked, or the firmware is too old'));
      }, this.timeoutMs);
      const off = this.link.onAdmin((reply) => {
        if (reply.requestId !== id) return;
        const a = decodeAdmin(reply.payload);
        if (a.passkey) this.passkey = a.passkey;
        if (a.variant !== wantVariant || !(a.body instanceof Uint8Array)) {
          clearTimeout(timer);
          off();
          reject(new Error(`unexpected reply (admin variant ${a.variant})`));
          return;
        }
        clearTimeout(timer);
        off();
        resolve(a.body);
      });
      this.link.send(adminPacket(this.to, id, msg, true)).catch((err) => {
        clearTimeout(timer);
        off();
        reject(err);
      });
    });
  }

  /**
   * Fetch one configuration block.
   * @param {number} type AdminMessage.ConfigType
   * @param {number} variant the Config oneof member expected back
   * @returns {Promise<Uint8Array>} the block's bytes
   */
  async getConfig(type, variant) {
    const config = await this.request(admin.getConfig(type, this.passkey), ADMIN.GET_CONFIG_RESPONSE);
    const v = configVariant(config);
    // An empty block is legitimate: a config of all defaults encodes to
    // nothing. Only a different block is wrong.
    if (v && v.type !== variant) throw new Error(`asked for config ${type}, got variant ${v.type}`);
    return v ? v.body : new Uint8Array(0);
  }

  /** @param {number} index @returns {Promise<Uint8Array>} encoded Channel */
  getChannel(index) {
    return this.request(admin.getChannel(index, this.passkey), ADMIN.GET_CHANNEL_RESPONSE);
  }

  /**
   * Send a set command. No reply is defined for these; the read-back in
   * provisionTracker is what confirms them.
   * @param {number[]} msg
   */
  async set(msg) {
    await this.link.send(adminPacket(this.to, Session.id(), msg, false));
  }
}
