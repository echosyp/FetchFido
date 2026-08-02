// @ts-check
/**
 * Leaflet map wrapper.
 *
 * Leaflet is vendored under web/vendor/ and loaded as a global, so the app has
 * no build step and no runtime CDN dependency. See web/vendor/VENDOR.md for
 * provenance and hashes.
 */

import { colourFor } from './geo.js';
import { labelFor } from './meshtastic.js';

/** @typedef {import('./meshtastic.js').Position} Position */

// Leaflet attaches itself to window; there are no type definitions without a
// package manager, so it is deliberately untyped here.
const L = /** @type {any} */ (/** @type {any} */ (globalThis).L);

/**
 * Names come off the mesh and are attacker-controlled; Leaflet popups take
 * raw HTML.
 * @param {string} v
 */
function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
}

export class TrackMap {
  /** @param {string} elementId */
  constructor(elementId) {
    this.map = L.map(elementId, { center: [0, 0], zoom: 2, zoomControl: true });

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(this.map);

    /** @type {Map<string, any>} */
    this._markers = new Map();
    /** @type {Map<string, any>} */
    this._tracks = new Map();
    /** @type {any} */
    this._handler = null;
    this._followed = false;
  }

  /** Nudge Leaflet after layout changes; it mis-sizes in flex containers. */
  refresh() {
    setTimeout(() => this.map.invalidateSize(), 50);
  }

  /**
   * @param {number} lat
   * @param {number} lon
   */
  setHandler(lat, lon) {
    if (!this._handler) {
      this._handler = L.circleMarker([lat, lon], {
        radius: 7, color: '#fff', weight: 2, fillColor: '#1f6feb', fillOpacity: 1,
      }).addTo(this.map).bindPopup('You');
    } else {
      this._handler.setLatLng([lat, lon]);
    }
    if (!this._followed) {
      this.map.setView([lat, lon], 15);
      this._followed = true;
    }
  }

  /**
   * Draw one device's marker and breadcrumb trail.
   *
   * The trail is what makes a slow cadence usable -- a single pin gives no
   * sense of direction between updates (docs/PRD.md section 6.1).
   *
   * @param {string} deviceId
   * @param {Position[]} positions oldest first
   * @param {'fresh'|'stale'|'lost'} level
   */
  update(deviceId, positions, level) {
    if (positions.length === 0) return;
    const latest = positions[positions.length - 1];
    const colour = colourFor(deviceId);
    const latlngs = positions.map((p) => [p.lat, p.lon]);

    let track = this._tracks.get(deviceId);
    if (!track) {
      track = L.polyline(latlngs, { color: colour, weight: 3, opacity: 0.7 }).addTo(this.map);
      this._tracks.set(deviceId, track);
    } else {
      track.setLatLngs(latlngs);
    }

    // Stale positions fade rather than vanish -- the last known location is
    // the whole product once contact is lost.
    const opacity = level === 'fresh' ? 1 : level === 'stale' ? 0.6 : 0.3;

    let marker = this._markers.get(deviceId);
    if (!marker) {
      marker = L.circleMarker([latest.lat, latest.lon], {
        radius: 9, color: '#0d1117', weight: 2, fillColor: colour, fillOpacity: opacity,
      }).addTo(this.map);
      this._markers.set(deviceId, marker);
    } else {
      marker.setLatLng([latest.lat, latest.lon]);
      marker.setStyle({ fillOpacity: opacity });
    }
    marker.bindPopup(
      `<b>${escapeHtml(labelFor(deviceId))}</b><br><small>${deviceId}</small>` +
      `<br>${latest.lat.toFixed(5)}, ${latest.lon.toFixed(5)}` +
      `<br>${positions.length} fixes` +
      (latest.rssi !== null ? `<br>RSSI ${latest.rssi} dBm` : '') +
      (latest.snr !== null ? ` · SNR ${latest.snr.toFixed(1)}` : '')
    );
  }

  /** Fit the view to everything currently plotted. */
  fitAll() {
    const layers = [...this._markers.values()];
    if (this._handler) layers.push(this._handler);
    if (layers.length === 0) return;
    const group = L.featureGroup(layers);
    this.map.fitBounds(group.getBounds().pad(0.2));
  }
}
