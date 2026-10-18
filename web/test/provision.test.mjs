/**
 * Provisioning tests. Run with: node web/test/provision.test.mjs
 *
 * A fake node answers AdminMessages the way firmware does -- replies carry the
 * request id and a session passkey, set_config replaces a whole block -- so
 * the full read / write / verify / commit conversation runs without a radio.
 * What this cannot prove is that real firmware agrees with the schema; the
 * [verify] markers in js/provision.js are for that.
 */

import assert from 'node:assert/strict';
import { decodeFrames, myInfo, onAdmin } from '../js/meshtastic.js';
import { Reader, WIRE, putBytes, putUint, putBool, putFixed32, putString } from '../js/protobuf.js';
import {
  provisionTracker, adminPacket, decodeAdmin, configVariant, validateNames,
  trackerDeviceConfig, readDeviceConfig, readPositionConfig, readLoraConfig, readChannel,
  ADMIN, CONFIG, CONFIG_TYPE, ROLE, GPS_MODE, CHANNEL_ROLE, PUBLIC_MESH,
} from '../js/provision.js';

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (err) { console.error('FAIL  ' + name + '\n      ' + (err.stack || err.message)); process.exitCode = 1; }
}

// ---- helpers ---------------------------------------------------------------

/** Unwrap ToRadio -> MeshPacket -> Data -> AdminMessage. */
function parseToRadio(bytes) {
  let packet = null;
  new Reader(bytes).each((f, w, r) => { if (f === 1 && w === WIRE.LEN) { packet = r.bytes(); return true; } return false; });
  assert.ok(packet, 'ToRadio.packet present');
  let to = 0, id = 0, data = null;
  new Reader(packet).each((f, w, r) => {
    if (f === 2) { to = r.u32(); return true; }
    if (f === 6) { id = r.u32(); return true; }
    if (f === 4 && w === WIRE.LEN) { data = r.bytes(); return true; }
    return false;
  });
  let portnum = 0, payload = null, wantResponse = false;
  new Reader(data).each((f, w, r) => {
    if (f === 1) { portnum = r.varint(); return true; }
    if (f === 2 && w === WIRE.LEN) { payload = r.bytes(); return true; }
    if (f === 3) { wantResponse = r.varint() !== 0; return true; }
    return false;
  });
  return { to, id, portnum, wantResponse, admin: decodeAdmin(payload) };
}

/** Field numbers present in a message, in order. */
function fieldsOf(buf) {
  const out = [];
  const r = new Reader(buf);
  while (!r.done) { const tag = r.varint(); out.push(Math.floor(tag / 8)); r.skip(tag % 8); }
  return out;
}

const CONFIG_FIELD = { [CONFIG_TYPE.DEVICE]: CONFIG.DEVICE, [CONFIG_TYPE.POSITION]: CONFIG.POSITION, [CONFIG_TYPE.LORA]: CONFIG.LORA };

/**
 * Enough of a node to be configured. Holds encoded config blocks, replaces
 * them wholesale on set_config exactly as nanopb does, and answers requests
 * through the real decoder so the reply routing is exercised too.
 */
class FakeNode {
  constructor({ num = 0x9ea0eaac, region = 1, answer = true, ignoreDeviceSet = false } = {}) {
    this.num = num;
    this.answer = answer;
    this.ignoreDeviceSet = ignoreDeviceSet;
    this.passkey = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    this.sent = [];
    this.state = {
      // role CLIENT (absent = 0), serial on, an unknown string field, and a broadcast interval.
      [CONFIG.DEVICE]: new Uint8Array([...putBool(2, true), ...putString(77, 'keep'), ...putUint(7, 10800)]),
      [CONFIG.POSITION]: new Uint8Array([...putUint(1, 900), ...putUint(5, 30), ...putUint(7, 811), ...putUint(99, 5)]),
      [CONFIG.LORA]: new Uint8Array([...putBool(1, true), ...putUint(7, region), ...putUint(8, 3), ...putBool(9, true), ...putUint(50, 1)]),
    };
    this.channel = new Uint8Array([
      ...putUint(1, 0),
      ...putBytes(2, [...putBytes(2, new Array(16).fill(0x42)), ...putString(3, 'Private')]),
      ...putUint(3, CHANNEL_ROLE.PRIMARY),
    ]);
    this.owner = null;
  }

  link() {
    return { send: async (b) => this.receive(b), onAdmin, myNodeNum: () => this.num };
  }

  receive(bytes) {
    const m = parseToRadio(bytes);
    this.sent.push(m);
    const { variant, body } = m.admin;
    switch (variant) {
      case ADMIN.SET_CONFIG: {
        const v = configVariant(body);
        if (!(this.ignoreDeviceSet && v.type === CONFIG.DEVICE)) this.state[v.type] = v.body;
        break;
      }
      case ADMIN.SET_CHANNEL: this.channel = body; break;
      case ADMIN.SET_OWNER: this.owner = body; break;
      case ADMIN.GET_CONFIG_REQUEST:
        if (this.answer) this.reply(m.id, ADMIN.GET_CONFIG_RESPONSE, putBytes(CONFIG_FIELD[body], this.state[CONFIG_FIELD[body]]));
        break;
      case ADMIN.GET_CHANNEL_REQUEST:
        assert.equal(body, 1, 'channel 0 is requested as 1');
        if (this.answer) this.reply(m.id, ADMIN.GET_CHANNEL_RESPONSE, this.channel);
        break;
      default: break;
    }
  }

  /** Build FromRadio{packet{decoded{ADMIN_APP, AdminMessage, request_id}}} and push it through the decoder. */
  reply(requestId, variant, body) {
    const adminMsg = [...putBytes(variant, body), ...putBytes(ADMIN.SESSION_PASSKEY, this.passkey)];
    const data = [...putUint(1, 6), ...putBytes(2, adminMsg), ...putFixed32(6, requestId)];
    const packet = [...putFixed32(1, this.num), ...putFixed32(2, 0), ...putBytes(4, data), ...putFixed32(6, 1234)];
    decodeFrames(new Uint8Array(putBytes(2, packet)));
  }

  variants() { return this.sent.map((m) => m.admin.variant); }
}

const V = ADMIN;
const HAPPY_SEQUENCE = [
  V.GET_CONFIG_REQUEST, V.GET_CONFIG_REQUEST, V.GET_CONFIG_REQUEST, V.GET_CHANNEL_REQUEST,
  V.BEGIN_EDIT_SETTINGS,
  V.SET_OWNER, V.SET_CHANNEL, V.SET_CONFIG, V.SET_CONFIG, V.SET_CONFIG,
  V.GET_CONFIG_REQUEST, V.GET_CONFIG_REQUEST, V.GET_CONFIG_REQUEST, V.GET_CHANNEL_REQUEST,
  V.COMMIT_EDIT_SETTINGS,
];

// ---- tests -----------------------------------------------------------------

console.log('provisioning');

await test('patching a block keeps every field it does not touch', () => {
  const node = new FakeNode();
  const cfg = configVariant(new Uint8Array(trackerDeviceConfig(node.state[CONFIG.DEVICE])));
  assert.equal(cfg.type, CONFIG.DEVICE);
  const d = readDeviceConfig(cfg.body);
  assert.equal(d.role, ROLE.TRACKER);
  assert.equal(d.serialEnabled, true, 'serial_enabled survives');
  assert.ok(fieldsOf(cfg.body).includes(77), 'an unknown field survives byte for byte');
  assert.ok(fieldsOf(cfg.body).includes(7), 'node_info_broadcast_secs survives');
  assert.equal(fieldsOf(cfg.body).filter((f) => f === 1).length, 1, 'role written exactly once');
});

await test('an admin packet is addressed, numbered and flagged for a reply', () => {
  const m = parseToRadio(adminPacket(0x12345678, 0xabcdef01, putUint(ADMIN.GET_CONFIG_REQUEST, 0), true));
  assert.equal(m.to, 0x12345678);
  assert.equal(m.id, 0xabcdef01);
  assert.equal(m.portnum, 6);
  assert.equal(m.wantResponse, true);
  assert.equal(m.admin.variant, ADMIN.GET_CONFIG_REQUEST);
  assert.equal(m.admin.body, 0, 'DEVICE_CONFIG is zero and must still be on the wire');
});

await test('the handshake reveals the node\'s own number', () => {
  myInfo.num = null;
  decodeFrames(new Uint8Array(putBytes(3, putUint(1, 0x9ea0eaac))));
  assert.equal(myInfo.num, 0x9ea0eaac);
});

await test('admin replies reach subscribers with the request id they answer', () => {
  const seen = [];
  const off = onAdmin((r) => seen.push(r));
  new FakeNode().reply(777, ADMIN.GET_OWNER_RESPONSE, putString(2, 'x'));
  off();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].requestId, 777);
  assert.equal(seen[0].from, '!9ea0eaac');
  assert.deepEqual(Array.from(decodeAdmin(seen[0].payload).passkey), [0xde, 0xad, 0xbe, 0xef]);
});

await test('a stock client becomes a public-mesh tracker and is committed', async () => {
  const node = new FakeNode();
  const steps = [];
  const out = await provisionTracker(node.link(),
    { longName: 'Fido', shortName: 'FIDO', movingSecs: 30, stationarySecs: 300, moveThresholdM: 30 },
    (step, state) => steps.push(`${step}:${state}`));

  assert.deepEqual(node.variants(), HAPPY_SEQUENCE);

  const d = readDeviceConfig(node.state[CONFIG.DEVICE]);
  assert.equal(d.role, ROLE.TRACKER);
  assert.equal(d.serialEnabled, true);
  assert.equal(d.rebroadcastMode, 4);
  assert.ok(fieldsOf(node.state[CONFIG.DEVICE]).includes(77));

  const p = readPositionConfig(node.state[CONFIG.POSITION]);
  assert.equal(p.smart, true);
  assert.equal(p.gpsMode, GPS_MODE.ENABLED);
  assert.equal(p.broadcastSecs, 300);
  assert.equal(p.minIntervalSecs, 30);
  assert.equal(p.minDistanceM, 30);
  assert.equal(p.gpsUpdateSecs, 30);
  assert.equal(p.fixed, false);
  assert.ok(fieldsOf(node.state[CONFIG.POSITION]).includes(99));

  const l = readLoraConfig(node.state[CONFIG.LORA]);
  assert.equal(l.region, 1, 'region kept from the node');
  assert.equal(l.preset, PUBLIC_MESH.preset);
  assert.equal(l.usePreset, true);
  assert.equal(l.hopLimit, 3, 'hop limit untouched');
  assert.equal(l.txEnabled, true);

  const ch = readChannel(node.channel);
  assert.equal(ch.index, 0);
  assert.equal(ch.role, CHANNEL_ROLE.PRIMARY);
  assert.deepEqual(ch.psk, [1]);
  assert.equal(ch.name, '');
  assert.equal(ch.precision, 32);

  assert.ok(node.owner, 'owner written');
  const names = {};
  new Reader(node.owner).each((f, w, r) => { if (w === WIRE.LEN) { names[f] = new TextDecoder().decode(r.bytes()); return true; } return false; });
  assert.equal(names[2], 'Fido');
  assert.equal(names[3], 'FIDO');

  for (const m of node.sent.slice(4)) {
    assert.deepEqual(Array.from(m.admin.passkey), [0xde, 0xad, 0xbe, 0xef], `passkey on admin variant ${m.admin.variant}`);
  }

  assert.equal(out.nodeId, '!9ea0eaac');
  assert.equal(out.region, 'US');
  assert.equal(out.preset, 'LongFast');
  assert.equal(out.before.role, ROLE.CLIENT);
  assert.equal(out.before.channelName, 'Private');
  assert.equal(steps[0], 'read:run');
  assert.equal(steps[steps.length - 1], 'commit:ok');
});

await test('a chosen region overrides the node\'s', async () => {
  const node = new FakeNode({ region: 1 });
  const out = await provisionTracker(node.link(), { longName: 'Rex', shortName: 'REX', region: 3 });
  assert.equal(readLoraConfig(node.state[CONFIG.LORA]).region, 3);
  assert.equal(out.region, 'EU_868');
});

await test('a node with no region and no choice is refused before anything is written', async () => {
  const node = new FakeNode({ region: 0 });
  await assert.rejects(provisionTracker(node.link(), { longName: 'Rex', shortName: 'REX' }), /choose a region/);
  assert.ok(!node.variants().includes(ADMIN.BEGIN_EDIT_SETTINGS), 'no edit session opened');
  assert.ok(!node.variants().includes(ADMIN.SET_CONFIG), 'nothing written');
});

await test('a node that silently ignores a setting is not committed', async () => {
  const node = new FakeNode({ ignoreDeviceSet: true });
  await assert.rejects(provisionTracker(node.link(), { longName: 'Rex', shortName: 'REX' }), /role is 0, not tracker.*Nothing was committed/);
  assert.ok(!node.variants().includes(ADMIN.COMMIT_EDIT_SETTINGS), 'no commit');
});

await test('a node that never answers times out with a reason', async () => {
  const node = new FakeNode({ answer: false });
  await assert.rejects(
    provisionTracker(node.link(), { longName: 'Rex', shortName: 'REX', timeoutMs: 30 }),
    /no reply from the node/);
});

await test('the node number must be known first', async () => {
  const link = { send: async () => {}, onAdmin, myNodeNum: () => null };
  await assert.rejects(provisionTracker(link, { longName: 'Rex', shortName: 'REX' }), /not identified itself/);
});

await test('names are checked against the firmware buffers', () => {
  assert.deepEqual(validateNames('  Fido ', 'FIDO'), { longName: 'Fido', shortName: 'FIDO' });
  assert.throws(() => validateNames('', 'F'), /name is required/);
  assert.throws(() => validateNames('Fido', 'FIDOS'), /short name is too long/);
  assert.throws(() => validateNames('x'.repeat(40), 'F'), /too long/);
  // Multibyte: four characters can exceed four bytes.
  assert.throws(() => validateNames('Fido', 'Ñoño'), /short name is too long/);
});

await test('a cadence faster than the airtime floor is refused', async () => {
  const node = new FakeNode();
  await assert.rejects(provisionTracker(node.link(), { longName: 'Rex', shortName: 'REX', movingSecs: 5 }), /cadence/);
  await assert.rejects(provisionTracker(node.link(), { longName: 'Rex', shortName: 'REX', movingSecs: 60, stationarySecs: 30 }), /cadence/);
  assert.equal(node.sent.length, 0);
});

console.log(`\n${passed} passed`);
