# FetchFido PWA

Phase 1 client: connects to a Meshtastic radio over Bluetooth, plots reporting
nodes on a map with breadcrumb trails, and stores everything locally so it
keeps working with no connectivity.

## No package manager

There is no bundler, no `node_modules`, and no dependency tree. Everything here
is either a browser API, code in this repository, or a single vendored file
verified against a published hash (`vendor/VENDOR.md`).

`package.json` contains exactly one key — `{"type": "module"}` — which tells
Node to treat `.js` as ES modules when running the tests. Nothing is installed
and nothing is fetched from it. Browsers ignore it entirely.

The cost of this choice is that the Meshtastic protocol is decoded by hand in
`js/protobuf.js` and `js/meshtastic.js`, about 300 lines total. The benefit is
that every byte reaching a browser is reviewable in this tree.

## Layout

```
index.html          shell, strict CSP
sw.js               offline cache: shell cache-first, tiles network-first
css/app.css
js/protobuf.js      minimal protobuf wire-format reader
js/meshtastic.js    FromRadio -> MeshPacket -> Data -> Position
js/sources/types.js CollarSource contract
js/sources/base.js  shared listener plumbing
js/sources/ble.js   Web Bluetooth transport
js/sources/wifi.js  HTTP transport (the only one iOS can use)
js/store.js         IndexedDB, deduped on [deviceId, ts]
js/geo.js           distance, bearing, freshness
js/map.js           Leaflet wrapper
js/app.js           wiring
test/decode.test.mjs
vendor/             Leaflet 1.9.4, hash-verified
```

## Running

```bash
cd web
python3 -m http.server 8000 --bind 127.0.0.1
# open http://127.0.0.1:8000
```

Web Bluetooth requires a **secure context**. `127.0.0.1` counts as secure, so
desktop Chrome works over plain http.

**Testing from a phone** is the awkward part, because a LAN address over http
is *not* a secure context and the Connect button will fail:

- **Best:** Chrome remote debugging port-forward. Connect the phone by USB,
  open `chrome://inspect` on the desktop, add a port forward from phone
  `localhost:8000` to host `localhost:8000`. The phone then sees a secure
  origin.
- Or serve over https with a certificate — the Go binary already supports TLS
  (`TLS_CERT_FILE` / `TLS_KEY_FILE`), and a self-signed cert is enough.

### WiFi transport

Pick **WiFi** in the transport dropdown and enter the node's address
(`192.168.1.50`, or `node.lan`). The scheme is optional; `http://` is assumed.

This needs no secure context, so it works from a phone over plain http on the
LAN — which is exactly why it is the transport that serves iOS.

Two things will block it, and the status badge names both:

- **Mixed content.** A node speaking http cannot be reached from a page served
  over https. Serve the PWA over http when using WiFi. This is the opposite of
  what Bluetooth requires, so the two transports pull in different directions
  during development.
- **CORS.** The node must return permissive CORS headers for a cross-origin
  browser to talk to it. Serving this app *from the node itself* sidesteps the
  question entirely. [verify against firmware]

**Use `http://127.0.0.1:8000`, not the LAN address, when testing on the machine
running the server.** Loopback is treated as a trustworthy origin, so it is a
secure context while still being an http page. That is the only combination
that gets all three at once:

| | LAN IP | Loopback | https |
|---|---|---|---|
| Can reach an http node | yes | yes | **no** (mixed content) |
| Geolocation (range/bearing) | **no** | yes | yes |
| Service worker / offline | **no** | yes | yes |

On a plain-http LAN address `navigator.serviceWorker` is not even defined, so
nothing is cached — reloads always fetch fresh code, and the offline promise
does not hold. Worth knowing before concluding the app is serving stale files.

Note `connect-src` in the CSP is relaxed to `http: https:` for this feature —
the node address is arbitrary and CSP cannot express "any private address".
That is the weakest line in the policy and it is there for this transport
alone.

## Tests

```bash
node web/test/decode.test.mjs   # protobuf reader and Meshtastic decode
node web/test/wifi.test.mjs     # HTTP transport, with fetch stubbed
```

These build synthetic Meshtastic frames byte by byte and assert the decoder
recovers them, so the protobuf reader is verified without a radio. What they
cannot verify is whether the **field numbers** match current firmware — those
are marked `[verify]` in `js/meshtastic.js` and need one session with real
hardware.

## Field test instrumentation

Every stored position carries `rssi`, `snr` and `hops`, and **Export CSV**
writes them out. Duplicate deliveries are counted separately and shown in the
header as `dup` — that is a direct measure of mesh relay redundancy.

The question this is built to answer (docs/DESIGN.md section 11): at 40 cm off
the ground, in timber, at what distance does packet delivery fall below usable?
Walk a node away from the radio, export, and plot delivery against distance.

## Status

Working: BLE and WiFi transports, decode, dedupe store, map with trails,
position age, distance and bearing, CSV export, offline shell.

Not built: serial and server transports, geofencing, device claiming, dog
profiles, pre-cached offline map regions, any server at all.
