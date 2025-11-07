/**
 * GPS Data Handler
 * This file handles the initialization of GPS data from server-side templates
 * This file is processed as a template by the Go server to inject GPS data
 */

// Initialize GPS data from server-side template
window.gpsData = [
    {{range .Messages}}
    {{if .Coordinates.Valid}}
    {
        lat: {{.Coordinates.Latitude}},
        lng: {{.Coordinates.Longitude}},
        timestamp: "{{.Timestamp.Format "2006-01-02 15:04:05"}}",
        source: {{printf "%q" .Source}},
        data: {{printf "%q" .Data}}
    },
    {{end}}
    {{end}}
];

console.log('GPS data initialized from template:', window.gpsData);