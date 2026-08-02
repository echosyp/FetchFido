// @ts-check
/**
 * Geodesy and formatting helpers.
 *
 * Distance and bearing from handler to dog is the single most used number in
 * the field (docs/PRD.md section 8.2), so it must be correct and readable at
 * arm's length.
 */

const R = 6371000; // mean Earth radius, metres

/** @param {number} d */
const rad = (d) => (d * Math.PI) / 180;
/** @param {number} r */
const deg = (r) => (r * 180) / Math.PI;

/**
 * Great-circle distance in metres.
 * @param {number} lat1 @param {number} lon1 @param {number} lat2 @param {number} lon2
 * @returns {number}
 */
export function distance(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Initial great-circle bearing, degrees true.
 * @param {number} lat1 @param {number} lon1 @param {number} lat2 @param {number} lon2
 * @returns {number}
 */
export function bearing(lat1, lon1, lat2, lon2) {
  const dLon = rad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
    Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** @param {number} b @returns {string} */
export function compass(b) {
  return POINTS[Math.round(b / 22.5) % 16];
}

/**
 * @param {number} metres
 * @param {'metric'|'imperial'} units
 * @returns {string}
 */
export function formatDistance(metres, units = 'imperial') {
  if (units === 'imperial') {
    const yards = metres * 1.09361;
    if (yards < 1000) return `${Math.round(yards)} yd`;
    return `${(metres / 1609.34).toFixed(2)} mi`;
  }
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(2)} km`;
}

/**
 * Freshness of a position. The UI degrades in defined steps rather than
 * showing an unqualified marker -- acting on a five-minute-old position
 * believing it current is the failure this prevents.
 * @param {number} ageSec
 * @returns {{label: string, level: 'fresh'|'stale'|'lost'}}
 */
export function freshness(ageSec) {
  const label = formatAge(ageSec);
  if (ageSec < 90) return { label, level: 'fresh' };
  if (ageSec < 600) return { label, level: 'stale' };
  return { label, level: 'lost' };
}

/** @param {number} sec @returns {string} */
export function formatAge(sec) {
  if (sec < 0) return 'now';
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

/**
 * Stable colour per device, so a dog keeps its colour across sessions without
 * anyone having to assign one.
 * @param {string} id
 * @returns {string}
 */
export function colourFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}, 70%, 55%)`;
}
