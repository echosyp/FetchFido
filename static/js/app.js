let map;
let markers = [];
let autoRefreshEnabled = true;
let autoRefreshTimer = null;

function autoRefresh() {
    if (autoRefreshEnabled) {
        autoRefreshTimer = setTimeout(function() {
            location.reload();
        }, 10000);
    }
}

function toggleAutoRefresh() {
    autoRefreshEnabled = !autoRefreshEnabled;
    const button = document.getElementById('auto-refresh-toggle');
    const status = document.getElementById('auto-refresh-status');

    if (autoRefreshEnabled) {
        button.textContent = 'Disable Auto-refresh';
        button.classList.add('enabled');
        button.classList.remove('disabled');
        status.textContent = 'Auto-refresh in 10 seconds';
        autoRefresh(); // Start the timer
    } else {
        button.textContent = 'Enable Auto-refresh';
        button.classList.add('disabled');
        button.classList.remove('enabled');
        status.textContent = 'Auto-refresh disabled';
        if (autoRefreshTimer) {
            clearTimeout(autoRefreshTimer);
            autoRefreshTimer = null;
        }
    }
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

function addMarkersToMap() {
    // Clear existing markers
    markers.forEach(marker => map.removeLayer(marker));
    markers = [];

    // Add new markers
    window.gpsData.forEach((point, index) => {
        const marker = L.marker([point.lat, point.lng]).addTo(map);

        // Create popup content
        const popupContent = `
            <div>
                <h4>GPS Location ${index + 1}</h4>
                <p><strong>Coordinates:</strong> ${point.lat}, ${point.lng}</p>
                <p><strong>Timestamp:</strong> ${point.timestamp}</p>
                <p><strong>Source:</strong> ${point.source}</p>
                <p><strong>Raw Data:</strong> ${point.data}</p>
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
    autoRefresh();
});