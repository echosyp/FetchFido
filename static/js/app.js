let map;
let markers = [];
let autoRefreshEnabled = true;
let eventSource = null;

function setRefreshStatus(text) {
    const status = document.getElementById('auto-refresh-status');
    if (status) {
        status.textContent = text;
    }
}

// The sequence number this page was rendered at. Anything higher means
// coordinates have been stored since, so what is on screen is out of date.
function renderedSeq() {
    return typeof window.gpsSeq === 'number' ? window.gpsSeq : 0;
}

// Refresh when coordinates actually arrive rather than on a timer. The server
// pushes the current sequence over /events; EventSource handles reconnection on
// its own, so a dropped connection recovers without a polling loop.
function startAutoRefresh() {
    if (eventSource) {
        return;
    }

    eventSource = new EventSource('/events');

    eventSource.addEventListener('open', function() {
        setRefreshStatus('Waiting for new coordinates');
    });

    eventSource.addEventListener('seq', function(event) {
        const seq = parseInt(event.data, 10);
        if (!isNaN(seq) && seq > renderedSeq()) {
            setRefreshStatus('New coordinates received, refreshing…');
            location.reload();
        }
    });

    eventSource.addEventListener('error', function() {
        // Fires while EventSource is between retries as well as on a hard
        // failure; either way the browser is already backing off and retrying.
        setRefreshStatus('Live updates disconnected, reconnecting…');
    });
}

function stopAutoRefresh() {
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }
}

function toggleAutoRefresh() {
    autoRefreshEnabled = !autoRefreshEnabled;
    const button = document.getElementById('auto-refresh-toggle');

    if (autoRefreshEnabled) {
        button.textContent = 'Disable Auto-refresh';
        button.classList.add('enabled');
        button.classList.remove('disabled');
        setRefreshStatus('Connecting for live updates…');
        startAutoRefresh();
    } else {
        button.textContent = 'Enable Auto-refresh';
        button.classList.add('disabled');
        button.classList.remove('enabled');
        setRefreshStatus('Auto-refresh disabled');
        stopAutoRefresh();
    }
}

// The store is in memory only, so a clear cannot be undone and CSV export is the
// only way the data survives. Worth one confirmation step that says so.
function clearMessages() {
    const warning = 'Clear all stored coordinates?\n\n' +
        'The store is in memory only, so this cannot be undone. ' +
        'Export CSV first if you need to keep the data.';

    if (!confirm(warning)) {
        return;
    }

    fetch('/clear', {method: 'POST'})
        .then(function(response) {
            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }
            return response.json();
        })
        .then(function(result) {
            console.log('Cleared', result.cleared, 'message(s)');
            location.reload();
        })
        .catch(function(error) {
            alert('Clear failed: ' + error.message);
        });
}

// The limit rides in the query string rather than localStorage so that
// location.reload() - which is how the live-refresh stream repaints the page -
// carries it across automatically.
function changeLimit(select) {
    const url = new URL(window.location.href);

    if (select.value === 'all') {
        url.searchParams.delete('limit');
    } else {
        url.searchParams.set('limit', select.value);
    }

    window.location.href = url.toString();
}

function initMap() {
    try {
        console.log('Initializing map...');
        console.log('GPS data:', window.gpsData);

        // Initialize map with explicit options - no default location, zoomed out view
        map = L.map('map', {
            center: [0, 0], // World center
            zoom: 2, // Zoomed out to show world view
            zoomControl: true,
            scrollWheelZoom: true
        });
        console.log('Map created with world view');

        // Add OpenStreetMap tile layer
        const tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            maxZoom: 30
        });

        tileLayer.addTo(map);
        console.log('Tile layer added');

        // Force map to invalidate size (helps with display issues)
        setTimeout(() => {
            map.invalidateSize();
            console.log('Map size invalidated');
        }, 100);

        // Add markers for GPS coordinates if available
        if (window.gpsData && window.gpsData.length > 0) {
            console.log('Adding markers for', window.gpsData.length, 'GPS points');
            addMarkersToMap();

            // Center map on the most recent coordinate with higher zoom
            const mostRecent = window.gpsData[window.gpsData.length - 1];
            map.setView([mostRecent.lat, mostRecent.lng], 15);
        } else {
            console.log('No GPS data available, showing world view');
        }

        console.log('Map initialization complete');
    } catch (error) {
        console.error('Error initializing map:', error);
    }
}

// Confidence bands in metres. PROTOCOL.md records a fix reporting 77.5 m that
// was measured ~490 m from the true position, so these describe how much to
// trust a point, not a radius to draw. A legacy 2-field fix carries no
// confidence at all and is drawn differently again rather than being coloured as
// if it were good.
const CONFIDENCE_BANDS = [
    {max: 10,       color: '#3fb950', label: 'good'},
    {max: 30,       color: '#d29922', label: 'fair'},
    {max: Infinity, color: '#f85149', label: 'poor'}
];

const UNKNOWN_CONFIDENCE = {color: '#8b949e', label: 'not reported'};

function confidenceStyle(point) {
    if (!point.extended || point.confidence === null) {
        return UNKNOWN_CONFIDENCE;
    }
    return CONFIDENCE_BANDS.find(band => point.confidence <= band.max);
}

// Radius grows with reported error so a vague fix visibly occupies more ground
// than a precise one, but only weakly (sqrt) and clamped - a 500 m reading drawn
// to scale would swamp the map at street zoom.
function confidenceRadius(point) {
    if (!point.extended || point.confidence === null) {
        return 6;
    }
    return Math.max(5, Math.min(18, 4 + Math.sqrt(point.confidence)));
}

function markerFor(point) {
    const style = confidenceStyle(point);

    return L.circleMarker([point.lat, point.lng], {
        radius: confidenceRadius(point),
        color: style.color,
        fillColor: style.color,
        fillOpacity: 0.45,
        weight: 2
    });
}

function addMarkersToMap() {
    // Clear existing markers
    markers.forEach(marker => map.removeLayer(marker));
    markers = [];

    // Add new markers
    window.gpsData.forEach((point, index) => {
        const marker = markerFor(point).addTo(map);

        // Only present on the extended payload. fixTime is separately null when
        // the device had no clock, which is not the same as no reading at all.
        const style = confidenceStyle(point);
        const extendedDetail = point.extended ? `
                <p><strong>Fix taken:</strong> ${point.fixTime || 'unknown (device had no clock)'}</p>
                <p><strong>Confidence:</strong> ${point.confidence} m (${style.label})</p>
                <p><strong>Satellites seen:</strong> ${point.satellites}</p>
        ` : '';

        // Create popup content
        const popupContent = `
            <div>
                <h4>GPS Location ${index + 1}</h4>
                <p><strong>Coordinates:</strong> ${point.lat}, ${point.lng}</p>
                <p><strong>Received:</strong> ${point.timestamp}</p>
                <p><strong>Source:</strong> ${point.source}</p>
                <p><strong>Raw Data:</strong> ${point.data}</p>${extendedDetail}
            </div>
        `;

        marker.bindPopup(popupContent);
        markers.push(marker);
    });

    // Draw path if multiple points
    if (window.gpsData.length > 1) {
        const path = window.gpsData.map(point => [point.lat, point.lng]);

        const polyline = L.polyline(path, {
            color: 'red',
            weight: 3,
            opacity: 0.8
        }).addTo(map);

        // Fit map to show all points
        map.fitBounds(polyline.getBounds());
    }
}

// Initialize map when page loads
document.addEventListener('DOMContentLoaded', function() {
    console.log('DOM loaded');

    // Wait for Leaflet to be available
    function waitForLeaflet() {
        if (typeof L !== 'undefined') {
            console.log('Leaflet loaded');
            // Initialize map if container exists
            const mapContainer = document.getElementById('map');
            if (mapContainer) {
                console.log('Map container found, initializing map');
                initMap();
            } else {
                console.log('Map container not found');
            }
        } else {
            console.log('Waiting for Leaflet...');
            setTimeout(waitForLeaflet, 100);
        }
    }

    waitForLeaflet();

    // Start auto-refresh
    startAutoRefresh();
});