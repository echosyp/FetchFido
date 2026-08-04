/**
 * GPS Data Handler
 * This file handles the initialization of GPS data from server-side templates
 * This file is processed as a template by the Go server to inject GPS data
 */

// Number of messages stored over the server's lifetime at the moment this page
// was rendered. The live-refresh stream compares against it to decide whether
// anything has arrived since. It keeps rising after the buffer is full, which a
// message count would not.
window.gpsSeq = {{.Seq}};

// Initialize GPS data from server-side template, oldest first so the map draws
// the track in the order the positions were captured.
window.gpsData = [
    {{range .Messages}}
    {{if .Coordinates.Valid}}
    {
        lat: {{.Coordinates.Latitude}},
        lng: {{.Coordinates.Longitude}},
        timestamp: "{{.Timestamp.Format "2006-01-02 15:04:05"}}",
        source: {{printf "%q" .Source}},
        data: {{printf "%q" .Data}},
        extended: {{.Coordinates.Extended}},
        // null when the payload carried no clock reading — unknown, not 1970.
        fixTime: {{with .Coordinates.FixTime}}"{{.Format "2006-01-02 15:04:05"}} UTC"{{else}}null{{end}},
        confidence: {{if .Coordinates.Extended}}{{.Coordinates.Confidence}}{{else}}null{{end}},
        satellites: {{if .Coordinates.Extended}}{{.Coordinates.Satellites}}{{else}}null{{end}}
    },
    {{end}}
    {{end}}
];

console.log('GPS data initialized from template:', window.gpsData);
