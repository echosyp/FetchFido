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
import { diag, labelFor, nodeNames, onNodeName, primeNodeName } from './meshtastic.js';
import { TrackMap } from './map.js';
import { distance, bearing, compass, formatDistance, freshness, colourFor, relativeBearing } from './geo.js';
import { Compass } from './heading.js';

/** @typedef {import('./meshtastic.js').Position} Position */

/** @type {Map<string, Position[]>} */
const tracks = new Map();

/** @type {{lat: number, lon: number}|null} */
let handler = null;

/** Device currently being navigated to, or null. */
let selectedId = /** @type {string|null} */ (null);

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

/** @returns {{transport: string, address: string}} */
function loadPrefs() {
  try {
    return { transport: 'ble', address: '', ...JSON.parse(localStorage.getItem(PREFS) || '{}') };
  } catch {
    return { transport: 'ble', address: '' };
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
    primeNodeName(d.deviceId, { long: d.long || '', short: d.short || '' });
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
 * Escape text taken from the mesh. Node names are attacker-controlled: anyone
 * on the channel can set their own long name, and it is rendered into the DOM.
 * @param {string} v
 */
function esc(v) {
  return String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
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

function render() {
  const now = Date.now() / 1000;
  const panel = el('dogs');
  panel.innerHTML = '';

  // Sort by display label so the list reads naturally, not by hex id.
  const ids = [...tracks.keys()].sort((a, b) =>
    labelFor(a).localeCompare(labelFor(b), undefined, { sensitivity: 'base' }));
  if (ids.length === 0) {
    panel.innerHTML = '<p class="empty">No positions yet. Connect a radio and wait for a node to report.</p>';
  }

  for (const id of ids) {
    const list = tracks.get(id) || [];
    if (list.length === 0) continue;
    const latest = list[list.length - 1];
    const age = now - latest.ts;
    const fresh = freshness(age);

    map.update(id, list, fresh.level);

    let range = '';
    if (handler) {
      const d = distance(handler.lat, handler.lon, latest.lat, latest.lon);
      const b = bearing(handler.lat, handler.lon, latest.lat, latest.lon);
      range = `<div class="range">${formatDistance(d)} · ${compass(b)} ${Math.round(b)}&deg;</div>`;
    }

    const radio = [
      latest.rssi !== null ? `RSSI ${latest.rssi}` : null,
      latest.snr !== null ? `SNR ${latest.snr.toFixed(1)}` : null,
      latest.hops !== null ? (latest.hops === 0 ? 'direct' : `${latest.hops} hop${latest.hops > 1 ? 's' : ''}`) : null,
      latest.sats !== null ? `${latest.sats} sats` : null,
    ].filter(Boolean).join(' · ');

    const card = document.createElement('div');
    card.className = 'dog ' + fresh.level;
    card.style.borderLeftColor = colourFor(id);
    const named = nodeNames.get(id);
    card.innerHTML = `
      <div class="dog-head">
        <span class="dog-name">${esc(labelFor(id))}</span>
        <span class="age ${fresh.level}">${fresh.label}</span>
      </div>
      <div class="dog-id">${named?.short ? esc(named.short) + ' · ' : ''}${id}</div>
      ${range}
      <div class="coords">${latest.lat.toFixed(5)}, ${latest.lon.toFixed(5)}</div>
      <div class="radio">${radio || '&nbsp;'}</div>
      <div class="fixes">${list.length} fixes</div>
    `;
    card.addEventListener('click', () => selectDevice(id));
    if (id === selectedId) card.classList.add('selected');
    panel.appendChild(card);
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
  const header = 'device_id,timestamp_utc,lat,lon,alt_m,speed,heading,sats,rssi_dbm,snr_db,hops,link';
  const body = rows.map((p) => [
    p.deviceId,
    new Date(p.ts * 1000).toISOString(),
    p.lat, p.lon,
    p.alt ?? '', p.speed ?? '', p.heading ?? '', p.sats ?? '',
    p.rssi ?? '', p.snr ?? '', p.hops ?? '', p.link,
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
