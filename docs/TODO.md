# FetchFido — To-do (saas-redesign)

Planned work for this branch, in priority order as added. Each item names the
PRD / DESIGN section it extends so the reasoning behind it is not lost. The
"Not built" line in `web/README.md` tracks what the current client lacks; this
tracks what comes next.

## 1. Auto-configure a Meshtastic device as a tracker on a public mesh

Give the app a "set up this node as a collar" action. The user connects a stock
Meshtastic node over Bluetooth, serial or WiFi and the app writes the
configuration a tracker needs, instead of them doing it by hand in the
Meshtastic client:

- Join the public (community) mesh: channel, PSK, region and modem preset.
- Enable GPS and set a position broadcast cadence that fits the airtime budget
  (DESIGN §3.2), with the smart-broadcast behaviour from DESIGN §12 q1 checked
  against real firmware.
- Set role (tracker), owner name, and power settings suited to a collar.

Extends DESIGN §4 (device identity and provisioning) and PRD §8.1. Writing
config means the client needs the *ToRadio* side of the protocol, which
`js/meshtastic.js` currently only decodes from; the admin messages must be
encoded by hand as well, in keeping with the no-dependency stance.

**Status (2026-10-17):** built in `web/js/provision.js` with a dialog in the
app; see "Setting up a collar" in `web/README.md`. Tested against a fake node.
**Remaining:** one session against real hardware to settle the `[verify]`
markers (position precision 32, session passkey on local admin), and to
confirm smart-broadcast's movement threshold behaves as DESIGN §3.2 wants.

## 2. Public hosted version with accounts and a community mesh

A hosted FetchFido that anyone can log in to and track their own animals,
without deploying the app themselves or building a mesh. The public version runs
a community mesh anyone can join: collars configured by item 1 report into it,
and the hosted service shows each user only the animals they have claimed.

This is PRD §11 (SaaS column) and phase 5 of PRD §12, pulled forward, plus the
"anyone can use this, whether or not they have a mesh" goal from PRD §3. It
needs:

- Accounts and multi-tenancy (DESIGN §6.4), claiming as a hard gate (DESIGN §4,
  "SaaS: claiming is mandatory") so strangers' nodes on the shared mesh are
  never shown to the wrong user.
- A server ingest path from the community mesh (gateway nodes forwarding to the
  server, DESIGN §2), since the phone will not always be in range of the mesh.
- The same code as self-host, no feature gating (PRD §11).

**Status (2026-10-18):** server built (`cmd/`, `internal/`), with the
decision recorded in DESIGN §6: one Go codebase, native + SQLite in a scratch
container for self-host, WebAssembly + D1 in a Cloudflare Worker for the hosted
version. Accounts, claiming as a hard gate, tenant isolation in the store,
retention, CSV export; the PWA syncs its outbox, pulls history and claims
collars. Container verified end to end locally; image tagged
`quay.io/f0c8bbv93/fetchfido`. **Remaining:** the first real Worker deploy
(item 3) to confirm D1 driver behaviour and cold start; gateway ingest from the
community mesh, since positions reach the server only through phones today;
account recovery (there is no email sending, so no password reset yet); a
per-device rate limit on sync.

## 3. Auto-deploy the public version on Cloudflare Workers

Continuous deployment so a push to this branch publishes the public version.
`web/README.md` currently documents a manual Cloudflare Pages upload; replace it
with Workers (static assets plus the server-side parts of item 2 as Worker
code), deployed from CI on every push, with `_headers` behaviour preserved.
Keep the no-package-manager constraint in mind when choosing how the deploy
runs: prefer Cloudflare's git integration or a pinned, hash-verified CLI over a
dependency tree.

**Status (2026-10-18):** deployed by hand and working at
https://fetchfido.echosyp.workers.dev: D1 database created, its id in
`wrangler.jsonc`, `npx wrangler@4 deploy` runs `make worker` and uploads the
WASM plus the assets (`web/.assetsignore` keeps tests and READMEs out). The
first deploy found that password hashing in WebAssembly blew the free plan's
10 ms CPU limit (Cloudflare error 1102); the derivation now runs in the browser
(`web/js/kdf.js`, `internal/auth`). Cold start measured 7 ms, a login round
trip well under the limit. Not yet done: connect the repository to Workers
Builds so a push to this branch deploys (the build image needs Go 1.24+ for
`make worker`; verify), and a custom domain.
