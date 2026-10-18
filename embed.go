// Package fetchfido holds the PWA as an embedded filesystem so the self-hosted
// server is a single static binary with no separate web server
// (docs/DESIGN.md section 9).
//
// Only what a browser needs is embedded. Tests, the README and package.json
// belong to the source tree, and _headers is Cloudflare's; the Go server sets
// the same headers itself (internal/api).
package fetchfido

import "embed"

//go:embed web/index.html web/sw.js web/favicon.svg web/manifest.webmanifest
//go:embed web/css web/js web/vendor/leaflet.css web/vendor/leaflet.js
var Web embed.FS
