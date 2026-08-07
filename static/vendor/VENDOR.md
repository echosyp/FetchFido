# Vendored dependencies

This project deliberately uses **no package manager**. Third-party code is
downloaded once, verified against a published hash, committed, and reviewed like
any other file in the tree. The goal is that every byte shipped to a browser is
something a reader of this repository can inspect.

Adding anything here should be rare and argued for.

## Contents

| File | Version | Licence | SHA-256 (base64, SRI format) |
|---|---|---|---|
| `leaflet.js` | 1.9.4 | BSD-2-Clause | `sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=` |
| `leaflet.css` | 1.9.4 | BSD-2-Clause | `sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=` |

Source: `https://unpkg.com/leaflet@1.9.4/dist/`

These are the same Subresource Integrity values the page previously carried on
its CDN `<script>` and `<link>` tags, so the vendored copies are byte-identical
to what the browser was already being asked to verify.

## Why vendored

The dashboard is served on a LAN that may have no route to the internet, and a
map that silently fails to load is worse than no map. A CDN also means a third
party can change what executes in the browser between page loads; SRI catches
that but only by breaking the page.

## Verification

To confirm a file has not been altered:

    openssl dgst -sha256 -binary static/vendor/leaflet.js | openssl base64

The output must match the table above. The same check works against a freshly
downloaded copy from the source URL before committing an upgrade.

## Upgrading

1. Download the new version from the source URL.
2. Compute the hash as above and compare it with the SRI value published by the
   upstream project.
3. Replace the file, update the version and hash in this table, and commit both
   together so the record cannot drift from the file.
