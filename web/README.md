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
js/sources/serial.js Web Serial transport (cable; preferred off-grid)
js/framing.js       Meshtastic stream framing (serial only)
js/store.js         IndexedDB, deduped on [deviceId, ts]
js/geo.js           distance, bearing, relative bearing, freshness
js/heading.js       device compass (DeviceOrientation)
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

### USB cable transport

Pick **USB cable** and hit Connect; the browser shows a port chooser. Works on
desktop Chrome and Chrome for Android 150+ (with an OTG cable). Safari does not
implement Web Serial.

Unlike the HTTP transport, serial is **framed**: each FromRadio message is
wrapped in `0x94 0xC3 <len-hi> <len-lo>`, and the device writes plain-text debug
logs onto the same port. `js/framing.js` is a resumable state machine that
extracts frames, discards log text, and resynchronises after noise. Discarded
lines are kept in `SerialSource.log` -- useful when nothing else explains a
silence.

## Going off-grid

This is the intended field configuration: phone plus a node on a cable, dogs
carrying the remote nodes, no infrastructure at all.

The catch is not the radio, it is **delivering the app**. Off-grid there is no
server to load the page from, so it must already be cached -- which needs a
service worker, which needs a secure context. Web Serial and Web Bluetooth
*each* independently require a secure context too. So:

1. Before leaving connectivity, open the app from a secure origin -- https, or
   `chrome://flags/#unsafely-treat-insecure-origin-as-secure` with the LAN
   origin listed.
2. Install it (Chrome menu -> Install app). The service worker caches the shell.
3. Off-grid, launch the installed app. It runs from cache, and the cable or
   Bluetooth link to the node needs no network whatsoever.

Skipping step 1 leaves you with an app that cannot be opened and a transport
the browser refuses to expose.

Map tiles are cached only for areas already viewed, so pan over the ground you
intend to cover *before* you leave. Positions still record without a basemap,
but you will be reading coordinates off a blank grid.

## Tests

```bash
node web/test/decode.test.mjs   # protobuf reader and Meshtastic decode
node web/test/wifi.test.mjs     # HTTP transport, with fetch stubbed
node web/test/framing.test.mjs  # serial stream framing
node web/test/geo.test.mjs      # distance, bearing, arrow rotation
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

Working: WiFi transport (verified against real firmware), decode of both live
packets and the node database, dedupe store, map with trails, node names,
position age, tap-to-focus, direction indicator, CSV export, offline shell,
diagnostics.

The direction indicator needs a compass to point at anything. Without
`DeviceOrientation` -- desktops, and phones that only report relative
orientation -- it falls back to north-up and says so, because an arrow that
looks absolute while being relative walks you the wrong way.

Written but NOT yet run against hardware: BLE and USB cable transports. Both
are the off-grid path, so verifying them matters more than anything else here.

Not built: server transport, geofencing, device claiming, dog profiles,
pre-cached offline map regions, any server at all.
