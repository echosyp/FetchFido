// @ts-check
/**
 * FetchFido PWA -- application wiring.
 *
 * Phase 1 scope (docs/DESIGN.md section 10): BLE source, offline store, live
 * map with breadcrumbs, position age, distance and bearing. No server, no
 * auth, no geofence.
 */

import { BleSource } from './sources/ble.js';
import { WifiSource } from './sources/wifi.js';
import { SerialSource } from './sources/serial.js';
import * as store from './store.js';
import { diag, labelFor, nodeNames, nodeStatus, onNodeName, primeNodeName, radioConfig } from './meshtastic.js';
import { TrackMap } from './map.js';
import { distance, bearing, compass, formatDistance, formatAge, freshness, colourFor, relativeBearing } from './geo.js';
import { Compass } from './heading.js';

/** @typedef {import('./meshtastic.js').Position} Position */

/** @type {Map<string, Position[]>} */
const tracks = new Map();

/** @type {{lat: number, lon: number}|null} */
let handler = null;

/** Device currently being navigated to, or null. */
let selectedId = /** @type {string|null} */ (null);

/**
 * Device roles.
 *
 * Every position-reporting node renders as a dog otherwise -- including
 * stationary repeaters, the gateway itself, and on a community mesh every
 * stranger's node (docs/DESIGN.md section 11a). Marking a node as
 * infrastructure hides it without discarding its data.
 * @type {Map<string, 'collar'|'infra'>}
 */
const roles = new Map();

let hideInfra = false;

const heading = new Compass();

/** Field-test counters (docs/DESIGN.md section 11). */
const stats = { received: 0, stored: 0, duplicates: 0 };

/** @type {TrackMap} */
let map;

/** @type {import('./sources/types.js').CollarSource|null} */
let source = null;

const PREFS = 'fetchfido.prefs';

function el(id) {
  const e = document.getElementById(id);
  if (!e) throw new Error('missing element #' + id);
  return e;
}

/** @returns {{transport: string, address: string, hideInfra?: boolean}} */
function loadPrefs() {
  try {
    return { transport: 'ble', address: '', hideInfra: false,
      ...JSON.parse(localStorage.getItem(PREFS) || '{}') };
  } catch {
    return { transport: 'ble', address: '', hideInfra: false };
  }
}

/** @param {{transport: string, address: string}} p */
function savePrefs(p) {
  try {
    localStorage.setItem(PREFS, JSON.stringify(p));
  } catch {
    // Private browsing can refuse storage; the app still runs.
  }
}

/**
 * Build a source for the selected transport and attach listeners.
 * @param {string} kind
 * @param {string} address
 */
function makeSource(kind, address) {
  const s = kind === 'wifi' ? new WifiSource(address)
    : kind === 'serial' ? new SerialSource()
    : new BleSource();

  s.onStatus((state, detail) => {
    const badge = el('status');
    badge.textContent = detail ? `${state} — ${detail}` : state;
    badge.className = 'status ' + state;
    const btn = /** @type {HTMLButtonElement} */ (el('connect'));
    btn.textContent = state === 'connected' ? 'Disconnect' : 'Connect radio';
    btn.disabled = state === 'connecting';
  });

  s.onPosition(onPosition);
  return s;
}

async function boot() {
  map = new TrackMap('map');
  map.refresh();

  await restore();

  const prefs = loadPrefs();
  const transportEl = /** @type {HTMLSelectElement} */ (el('transport'));
  const addressEl = /** @type {HTMLInputElement} */ (el('address'));
  transportEl.value = prefs.transport;
  addressEl.value = prefs.address;

  const syncTransportUi = () => {
    const kind = transportEl.value;
    addressEl.hidden = kind !== 'wifi';
    const btn = /** @type {HTMLButtonElement} */ (el('connect'));

    // Report an unusable transport up front rather than on click. Both BLE and
    // Serial also need a secure context, which is the usual reason they are
    // missing on a plain-http LAN address.
    const probe = kind === 'ble' ? new BleSource()
      : kind === 'serial' ? new SerialSource()
      : null;

    if (probe && !probe.available()) {
      const why = window.isSecureContext
        ? `${probe.name} unsupported in this browser`
        : `${probe.name} needs a secure context — use 127.0.0.1 or https`;
      el('status').textContent = why;
      el('status').className = 'status offline';
      btn.disabled = true;
    } else {
      btn.disabled = false;
    }
  };

  transportEl.addEventListener('change', async () => {
    if (source && source.status() !== 'offline') await source.disconnect();
    source = null;
    savePrefs({ transport: transportEl.value, address: addressEl.value });
    syncTransportUi();
  });

  addressEl.addEventListener('change', () => {
    // The address is baked in at construction, so a change needs a new source.
    source = null;
    savePrefs({ transport: transportEl.value, address: addressEl.value });
  });

  syncTransportUi();

  el('connect').addEventListener('click', async () => {
    try {
      if (source && source.status() === 'connected') {
        await source.disconnect();
        return;
      }
      if (transportEl.value === 'wifi' && !addressEl.value.trim()) {
        el('status').textContent = 'enter the node address first';
        el('status').className = 'status offline';
        addressEl.focus();
        return;
      }
      if (!source) source = makeSource(transportEl.value, addressEl.value.trim());
      await source.connect();
    } catch (err) {
      console.error(err);
    }
  });

  el('fit').addEventListener('click', () => map.fitAll());
  el('export').addEventListener('click', exportCsv);
  el('clear').addEventListener('click', async () => {
    if (!confirm('Clear all stored positions for this session?')) return;
    await store.clear();
    await store.clearDevices();
    tracks.clear();
    location.reload();
  });

  hideInfra = !!prefs.hideInfra;
  const filterBtn = /** @type {HTMLButtonElement} */ (el('filter'));
  const syncFilter = () => {
    filterBtn.textContent = hideInfra ? 'Showing collars' : 'Showing all';
    filterBtn.classList.toggle('active', hideInfra);
  };
  filterBtn.addEventListener('click', () => {
    hideInfra = !hideInfra;
    savePrefs({ transport: transportEl.value, address: addressEl.value, hideInfra });
    syncFilter();
    render();
  });
  syncFilter();

  el('nav-close').addEventListener('click', () => selectDevice(null));

  heading.onChange(renderNav);

  onNodeName((id, name) => {
    void store.putDevice(id, name).catch((err) => console.warn('name save failed', err));
    render();
  });

  watchHandler();
  registerServiceWorker();
  setInterval(render, 1000); // ages must tick even with no new packets
  render();
}

/** Registered here rather than inline in the HTML, which the CSP forbids. */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch((err) => {
    // Not fatal: the app still works, it just will not survive going offline.
    console.warn('service worker registration failed', err);
  });
}

/** Reload positions and names held from a previous session. */
async function restore() {
  // Names first, so restored tracks render labelled rather than as raw hex.
  for (const d of await store.allDevices()) {
    if (d.long || d.short) {
      primeNodeName(d.deviceId, { long: d.long || '', short: d.short || '' });
    }
    if (d.role === 'collar' || d.role === 'infra') roles.set(d.deviceId, d.role);
  }

  const ids = await store.devices();
  for (const id of ids) {
    tracks.set(id, await store.track(id));
  }
}

/** @param {Position} p */
async function onPosition(p) {
  stats.received++;
  const isNew = await store.putPosition(p);
  if (!isNew) {
    // Same packet arriving by another mesh path. Expected, and a useful
    // measure of relay redundancy during a range test.
    stats.duplicates++;
    return;
  }
  stats.stored++;

  const list = tracks.get(p.deviceId) || [];
  list.push(p);
  list.sort((a, b) => a.ts - b.ts);
  tracks.set(p.deviceId, list);
  render();
}

/**
 * Handler's own position, for distance and bearing to each dog.
 *
 * Geolocation requires a secure context, which plain http on a LAN address is
 * not. That conflicts with the WiFi transport, which requires http to avoid
 * mixed-content blocking -- so over http you get positions but no range or
 * bearing. Failure is surfaced rather than logged, because a silently missing
 * distance reads as a bug.
 */
function watchHandler() {
  if (!('geolocation' in navigator)) {
    noteHandlerUnavailable('geolocation unsupported');
    return;
  }
  navigator.geolocation.watchPosition(
    (pos) => {
      handler = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      el('geo').textContent = '';
      map.setHandler(handler.lat, handler.lon);
      render();
    },
    (err) => {
      noteHandlerUnavailable(
        err.code === err.PERMISSION_DENIED && !window.isSecureContext
          ? 'no range/bearing: needs https'
          : `no range/bearing: ${err.message}`
      );
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
}

/** @param {string} msg */
function noteHandlerUnavailable(msg) {
  handler = null;
  el('geo').textContent = msg;
}

/**
 * Cycle a device between collar and infrastructure.
 * @param {string} id
 */
function toggleRole(id) {
  const next = roles.get(id) === 'infra' ? 'collar' : 'infra';
  roles.set(id, next);
  void store.putDevice(id, { role: next }).catch((err) => console.warn('role save failed', err));
  // Hiding the device you are navigating to would strand the arrow.
  if (next === 'infra' && hideInfra && selectedId === id) selectedId = null;
  render();
}

/**
 * Select a device to navigate to: centre the map on it and show the arrow.
 *
 * Compass startup happens here because iOS only grants orientation access from
 * a user gesture, and tapping a dog is the natural one.
 *
 * @param {string|null} id
 */
function selectDevice(id) {
  selectedId = id;
  if (id) {
    map.focus(id);
    void heading.start();
  }
  render();
}

/**
 * Draw the direction indicator.
 *
 * With a compass the arrow points at the dog in the real world. Without one it
 * can only be drawn north-up, which is still usable with a map but must say so
 * -- an arrow that looks absolute while being relative would walk someone the
 * wrong way.
 */
function renderNav() {
  const nav = el('nav');
  const list = selectedId ? tracks.get(selectedId) : null;

  if (!selectedId || !list || list.length === 0) {
    nav.hidden = true;
    return;
  }
  nav.hidden = false;

  const latest = list[list.length - 1];
  el('nav-name').textContent = labelFor(selectedId);

  const arrow = el('nav-arrow');
  if (!handler) {
    el('nav-dist').textContent = '—';
    el('nav-bearing').textContent = 'waiting for your location';
    el('nav-mode').textContent = window.isSecureContext ? '' : 'needs https or 127.0.0.1';
    arrow.style.transform = 'rotate(0deg)';
    arrow.classList.add('idle');
    return;
  }
  arrow.classList.remove('idle');

  const d = distance(handler.lat, handler.lon, latest.lat, latest.lon);
  const b = bearing(handler.lat, handler.lon, latest.lat, latest.lon);

  el('nav-dist').textContent = formatDistance(d);
  el('nav-bearing').textContent = `${compass(b)} ${Math.round(b)}\u00b0`;

  const h = heading.heading;
  if (h === null) {
    arrow.style.transform = `rotate(${b}deg)`;
    // Say *why* there is no compass. "North up" alone reads as a choice; the
    // usual cause is an insecure origin withholding the sensor entirely.
    el('nav-mode').textContent =
      !window.isSecureContext ? 'north up — compass needs https'
      : heading.relativeOnly ? 'north up — no compass reference'
      : !heading.available() ? 'north up — no compass on this device'
      : 'north up — hold the map north';
  } else {
    arrow.style.transform = `rotate(${relativeBearing(b, h)}deg)`;
    el('nav-mode').textContent = 'pointing at target';
  }
}

/**
 * Live card elements, keyed by device.
 *
 * Cards are reused rather than rebuilt. render() runs every second so ages
 * stay current, and tearing down the list that often reset the panel's scroll
 * position and pulled the tap target out from under a finger mid-press --
 * which made nodes further down the list effectively unreachable on a phone.
 * @type {Map<string, ReturnType<typeof makeCard>>}
 */
const cards = new Map();

/** @param {string} id */
function makeCard(id) {
  const mk = (/** @type {string} */ cls, /** @type {string} */ tag = 'div') => {
    const e = document.createElement(tag);
    e.className = cls;
    return e;
  };

  const root = mk('dog');
  root.style.borderLeftColor = colourFor(id);

  const head = mk('dog-head');
  const name = mk('dog-name', 'span');
  const age = mk('age', 'span');
  head.append(name, age);

  const role = mk('role', 'button');
  role.type = 'button';
  role.title = 'Mark as collar or infrastructure';
  head.append(role);

  const idline = mk('dog-id');
  const range = mk('range');
  const coords = mk('coords');
  const radio = mk('radio');
  const fixes = mk('fixes');

  root.append(head, idline, range, coords, radio, fixes);
  root.addEventListener('click', () => selectDevice(id));
  role.addEventListener('click', (e) => {
    // Otherwise the tap also selects the card and moves the map.
    e.stopPropagation();
    toggleRole(id);
  });

  return { root, name, age, idline, range, coords, radio, fixes, role };
}

function render() {
  const now = Date.now() / 1000;
  const panel = el('dogs');

  // Sort by display label so the list reads naturally, not by hex id.
  // Nodes the radio has heard but that carry no position still get a card. A
  // collar transmitting without a GPS fix is a different problem from one that
  // has gone silent, and omitting it makes the two look identical.
  const ids = [...new Set([...tracks.keys(), ...nodeStatus.keys()])]
    .filter((id) => (tracks.get(id) || []).length > 0 || nodeStatus.has(id))
    .filter((id) => !(hideInfra && roles.get(id) === 'infra'))
    .sort((a, b) => labelFor(a).localeCompare(labelFor(b), undefined, { sensitivity: 'base' }));

  let empty = document.getElementById('dogs-empty');
  if (ids.length === 0) {
    if (!empty) {
      empty = document.createElement('p');
      empty.id = 'dogs-empty';
      empty.className = 'empty';
      empty.textContent = 'No positions yet. Connect a radio and wait for a node to report.';
      panel.appendChild(empty);
    }
  } else if (empty) {
    empty.remove();
  }

  for (const id of ids) {
    const list = tracks.get(id) || [];
    const latest = list.length ? list[list.length - 1] : null;
    const status = nodeStatus.get(id);

    // Age from the position when we have one, otherwise from when the node was
    // last heard at all.
    const stamp = latest ? latest.ts : (status?.lastHeard || 0);
    const fresh = freshness(stamp ? now - stamp : Infinity);

    if (latest) map.update(id, list, fresh.level);

    let card = cards.get(id);
    if (!card) {
      card = makeCard(id);
      cards.set(id, card);
    }

    // textContent throughout: names come off the mesh and are attacker
    // controlled, and this way they are never parsed as markup at all.
    const role = roles.get(id);
    card.root.className = 'dog ' + fresh.level +
      (id === selectedId ? ' selected' : '') +
      (role === 'infra' ? ' infra' : '') +
      (latest ? '' : ' nofix');
    card.role.textContent = role === 'infra' ? 'infra' : 'collar';
    card.role.className = 'role' + (role === 'infra' ? ' infra' : '');
    card.name.textContent = labelFor(id);
    card.age.textContent = fresh.label;
    card.age.className = 'age ' + fresh.level;

    const short = nodeNames.get(id)?.short;
    card.idline.textContent = short ? `${short} · ${id}` : id;

    if (!latest) {
      // Heard, but no coordinates. Say so in the slot the eye goes to first.
      card.range.textContent = 'NO GPS FIX';
      card.range.hidden = false;
      card.coords.textContent = status?.lastHeard
        ? `radio ok · heard ${formatAge(now - status.lastHeard)}`
        : 'radio ok · never heard';
      card.radio.textContent = [
        status?.snr != null ? `SNR ${status.snr.toFixed(1)}` : null,
        status?.hops != null ? (status.hops === 0 ? 'direct' : `${status.hops} hops`) : null,
      ].filter(Boolean).join(' · ');
      card.fixes.textContent = 'no position yet';
    } else {
      if (handler) {
        const d = distance(handler.lat, handler.lon, latest.lat, latest.lon);
        const b = bearing(handler.lat, handler.lon, latest.lat, latest.lon);
        card.range.textContent = `${formatDistance(d)} · ${compass(b)} ${Math.round(b)}°`;
        card.range.hidden = false;
      } else {
        card.range.hidden = true;
      }

      card.coords.textContent = `${latest.lat.toFixed(5)}, ${latest.lon.toFixed(5)}`;
      card.radio.textContent = [
        // A node-database entry is the radio's last-known value, not a packet we
        // heard -- it has no RSSI, and counting it as a delivery would inflate
        // the range-test numbers.
        latest.link === 'nodedb' ? 'from node db' : null,
        latest.rssi !== null ? `RSSI ${latest.rssi}` : null,
        latest.snr !== null ? `SNR ${latest.snr.toFixed(1)}` : null,
        latest.hops !== null ? (latest.hops === 0 ? 'direct' : `${latest.hops} hop${latest.hops > 1 ? 's' : ''}`) : null,
        latest.sats !== null ? `${latest.sats} sats` : null,
      ].filter(Boolean).join(' · ');
      card.fixes.textContent = `${list.length} fixes`;
    }
  }

  // Drop cards and map layers for devices no longer listed -- either cleared,
  // or filtered out as infrastructure.
  for (const [id, card] of cards) {
    if (!ids.includes(id)) {
      card.root.remove();
      cards.delete(id);
      map.drop(id);
    }
  }

  // Reorder only when the order actually changed. Touching the DOM on every
  // tick is what caused the scroll to jump.
  const desired = ids.map((id) => /** @type {any} */ (cards.get(id)).root);
  const current = [...panel.querySelectorAll('.dog')];
  if (desired.length !== current.length || desired.some((n, i) => n !== current[i])) {
    for (const node of desired) panel.appendChild(node);
  }

  el('stats').textContent =
    `${stats.received} received · ${stats.stored} stored · ${stats.duplicates} dup`;

  renderDiag();
  renderNav();
}

/**
 * Report where incoming data stops.
 *
 * Without this, "no dogs on the map" is indistinguishable between nothing
 * arriving, packets arriving encrypted, and positions arriving that fail to
 * parse. Each has a different fix, so the app says which it is.
 */
function renderDiag() {
  const ports = [...diag.portnums.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `${p === 3 ? 'pos' : 'port' + p}:${n}`)
    .join(' ');

  const parts = [
    `${diag.bodies} bodies`,
    `${diag.packets} pkts`,
    diag.encrypted ? `${diag.encrypted} encrypted` : null,
    ports || null,
    diag.failures ? `${diag.failures} DECODE FAIL` : null,
  ].filter(Boolean);

  if (radioConfig.preset) {
    parts.push(`${radioConfig.preset}${radioConfig.region ? '/' + radioConfig.region : ''}`);
    if (radioConfig.hopLimit !== null) parts.push(`gw hops ${radioConfig.hopLimit}`);
  }

  const node = el('diag');
  node.textContent = parts.join(' · ');
  node.className = 'diag' + (diag.failures ? ' bad' : '');

  if (diag.lastFailureHex) {
    node.title = 'last failing position payload: ' + diag.lastFailureHex;
  }
}

/**
 * Export the session including RSSI, SNR and hop count.
 *
 * These columns are the point: packet delivery against distance is the curve
 * that decides preset defaults and whether mesh-only is viable at all
 * (docs/DESIGN.md section 11).
 */
async function exportCsv() {
  const rows = await store.allPositions();
  // Radio settings are stamped on every row so a session says which
  // configuration produced it. Comparing range-test runs across presets or hop
  // limits is meaningless if you cannot tell afterwards which CSV was which.
  const header = 'device_id,timestamp_utc,lat,lon,alt_m,speed,heading,sats,' +
    'rssi_dbm,snr_db,hops,hop_start,link,gw_preset,gw_hop_limit,gw_region';
  const body = rows.map((p) => [
    p.deviceId,
    new Date(p.ts * 1000).toISOString(),
    p.lat, p.lon,
    p.alt ?? '', p.speed ?? '', p.heading ?? '', p.sats ?? '',
    p.rssi ?? '', p.snr ?? '', p.hops ?? '', p.hopStart ?? '', p.link,
    radioConfig.preset ?? '', radioConfig.hopLimit ?? '', radioConfig.region ?? '',
  ].join(','));

  const blob = new Blob([[header, ...body].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fetchfido-session-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin',
    `<div class="fatal">Startup failed: ${err instanceof Error ? err.message : String(err)}</div>`);
});
