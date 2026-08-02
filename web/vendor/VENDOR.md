# Vendored dependencies

This project deliberately uses **no package manager**. Third-party code is
downloaded once, verified against a published hash, committed, and reviewed
like any other file in the tree. The goal is that every byte shipped to a
browser is something a reader of this repository can inspect.

Adding anything here should be rare and argued for.

## Contents

| File | Version | Licence | SHA-256 (base64, SRI format) |
|---|---|---|---|
| `leaflet.js` | 1.9.4 | BSD-2-Clause | `sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=` |
| `leaflet.css` | 1.9.4 | BSD-2-Clause | `sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=` |

Source: `https://unpkg.com/leaflet@1.9.4/dist/`

Leaflet was chosen because it is a single file with **no transitive
dependencies**, is already the map library used elsewhere in this project, and
carries a permissive licence.

## Verification

The hashes above are the same Subresource Integrity values that
`templates/index.html` on `main` already used to load Leaflet from a CDN — so
these files are cryptographically identical to what the project already
trusted. Vendoring removes the runtime dependency on unpkg; it does not
introduce new code.

To re-verify at any time:

```bash
openssl dgst -sha256 -binary web/vendor/leaflet.js | openssl base64
# expect 20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=

openssl dgst -sha256 -binary web/vendor/leaflet.css | openssl base64
# expect p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=
```

## Deliberately not vendored

- **`@meshtastic/js`** — the protocol subset we need is decoded by hand in
  `js/meshtastic.js` and `js/protobuf.js`. Roughly 300 auditable lines instead
  of a dependency tree.
- **`idb`** — IndexedDB is a browser API; the wrapper was only ergonomics.
- **`maplibre-gl` / `pmtiles`** — heavier than Leaflet and pulling more with
  them. Revisit only if vector tiles become a requirement.
