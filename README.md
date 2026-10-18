# FetchFido

An open, self-hostable dog tracker. Collars are stock Meshtastic nodes; a phone
shows where your dog is, with or without cell service, with or without a mesh
of your own, and with or without a server. See `docs/PRD.md` for the product
and `docs/DESIGN.md` for the architecture.

This repository holds two things that ship together:

- **The app** (`web/`): an offline-first PWA that talks to a Meshtastic radio
  over Bluetooth, USB or WiFi, plots collars on a map, and can set a stock node
  up as a collar in one step. No bundler, no `node_modules`; every byte a
  browser runs is in this tree. Its own README is `web/README.md`.
- **The server** (`cmd/`, `internal/`): one Go codebase, built two ways.
  Self-hosted, it is a static binary in a scratch container with SQLite,
  serving the app and the API from one port. Hosted, the same code compiles to
  WebAssembly and runs in a Cloudflare Worker with D1. Same API, same SQL,
  no feature gating between the two (`docs/PRD.md` section 11).

The server is a sync target, never a dependency: the app tracks exactly the
same with no server at all. What a server adds is history that survives the
phone, and seeing what other phones or gateways heard.

## Self-hosting

Privacy is the point of self-hosting: positions stay on a machine you control,
and there are no accounts to create. The server runs in **single mode**, one
tenant, and stores everything the app uploads.

```bash
podman build -t fetchfido .
podman run -d --name fetchfido -p 8080:8080 \
  -v fetchfido-data:/data \
  -e ACCESS_TOKEN=change-me \
  fetchfido
# open http://<host>:8080 and enter the token under the sync badge
```

A prebuilt image is published to `quay.io/f0c8bbv93/fetchfido`.

| Variable | Default | Meaning |
|---|---|---|
| `LISTEN` | `:8080` | Address to serve on |
| `DB_PATH` | `/data/fetchfido.db` | SQLite file; mount a volume at `/data` |
| `AUTH_MODE` | `single` | `single` (no accounts) or `accounts` |
| `ACCESS_TOKEN` | *(none)* | Single mode: required from every client when set. **Set it** unless the port is only reachable from a trusted network; the startup log warns otherwise. |
| `REGISTRATION` | `open` | Accounts mode: `open` or `closed` |
| `RETENTION_DAYS` | `30` | Positions older than this are deleted on each sync. `0` keeps forever. |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | *(none)* | Serve HTTPS directly. Otherwise put a reverse proxy in front. |
| `SECURE_COOKIES` | auto | Force the `Secure` flag when a proxy terminates TLS |
| `PBKDF2_ITERATIONS` | `600000` | Accounts mode password hashing cost |

The container is `FROM scratch`, runs as UID 65534, has no shell, and makes no
outbound connections. The binary is pure Go (`modernc.org/sqlite`), so
`CGO_ENABLED=0` and the image is the binary plus an empty `/data`.

HTTPS matters for more than privacy: the app's Bluetooth and serial transports,
geolocation and offline install all need a secure context. Over plain http
they work only from `127.0.0.1`. `web/README.md` covers the trade-offs.

## The hosted version

Same code, **accounts mode**: email and password, one tenant per account, and
only collars you have claimed are stored, so a stranger's node heard on the
public mesh never becomes a record in your account. It runs as a Cloudflare
Worker: `cmd/worker` compiled to WebAssembly, D1 for storage, the PWA served
from `web/` as static assets. Configuration is `wrangler.jsonc`; build with
`make worker`. Deployment is `docs/TODO.md` item 3.

## API

Both deployments serve `/api/v1`:

```
GET  /api/v1/health
GET  /api/v1/me                      mode, sign-in state, retention
POST /api/v1/auth/register           accounts mode
POST /api/v1/auth/login              {email,password} or {token}
POST /api/v1/auth/logout
GET  /api/v1/devices
POST /api/v1/devices/claim           {nodeId, name, shortName, colour}
DELETE /api/v1/devices/{nodeId}      also deletes its positions
POST /api/v1/sync                    {positions:[...]}, idempotent on (device, ts)
GET  /api/v1/positions?device=&from=&to=&limit=
GET  /api/v1/export?format=csv
```

Writes require JSON and a same-origin request; sessions are HttpOnly cookies.
Tenant isolation is enforced in `internal/store`, not in handlers.

## Development

```bash
make test       # gofmt, go vet, go test, and the web test suites (node)
make native     # ./fetchfido, the self-host binary
make worker     # build/app.wasm plus the Worker shim
make image      # the scratch container, tagged with the git SHA
```

Go 1.24+ and Node 18+ (for the web tests only). Dependencies are Go modules
pinned in `go.sum`: `modernc.org/sqlite` and `github.com/syumai/workers-go`.
Nothing is installed from npm.

## Layout

```
web/            the PWA (see web/README.md)
cmd/fetchfido   self-hosted server entry point
cmd/worker      Cloudflare Worker entry point (GOOS=js GOARCH=wasm)
internal/api    the HTTP API, both deployments
internal/store  schema and queries, SQLite dialect, tenant isolation
internal/auth   password hashing and session tokens
embed.go        embeds web/ into the native binary
Dockerfile      scratch container
wrangler.jsonc  Worker configuration
docs/           PRD, design, to-do
tools/          field-test analysis
```

## Licence

MIT. See `LICENSE`.
