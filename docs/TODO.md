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

## 3. Auto-deploy the public version on Cloudflare Workers

Continuous deployment so a push to this branch publishes the public version.
`web/README.md` currently documents a manual Cloudflare Pages upload; replace it
with Workers (static assets plus the server-side parts of item 2 as Worker
code), deployed from CI on every push, with `_headers` behaviour preserved.
Keep the no-package-manager constraint in mind when choosing how the deploy
runs: prefer Cloudflare's git integration or a pinned, hash-verified CLI over a
dependency tree.
