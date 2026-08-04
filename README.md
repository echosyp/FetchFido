# FetchFido

A security-hardened Go web service for receiving and visualizing GPS data over UDP. Built for learning Podman/Kubernetes deployment with a focus on security best practices and minimal container footprint.

## Features

- **UDP Data Reception**: Listens for GPS coordinates over UDP. Data that does not parse as coordinates is logged and dropped, so unrelated broadcast traffic on a shared network cannot evict real positions from the buffer.
- **Real-time GPS Visualization**: Interactive map powered by Leaflet.js displaying GPS locations
- **Multiple GPS Format Support**:
  - JSON format: `{"lat": 40.7128, "lon": -74.0060}`
  - Comma-separated: `40.7128,-74.0060`
  - Space-separated: `40.7128 -74.0060`
  - Extended tracker payload: `40.7128,-74.0060,1754160183,2.0,12` (see below)
- **Live Refresh**: The page refreshes when coordinates actually arrive, over a
  server-sent event stream, rather than on a fixed timer. Traffic that fails to
  parse does not trigger a refresh.
- **Most Recent First**: The message list is ordered newest at the top, by the
  time a fix was *captured* where the device reported it.
- **TLS 1.3 Support**: Optional HTTPS encryption for secure communication
- **Health & Info Endpoints**: Standard `/health` and `/info` endpoints for monitoring
- **Security Hardened**: Runs in a scratch container as non-root user (UID 65534)
- **Minimal Footprint**: UPX-compressed binary in scratch container for smallest possible image size

## Quick Start
`CONTAINER_HOST="ssh://echosyp@10.10.120.11:22/run/user/1000/podman/podman.sock" podman build Dckerfile `
### Prerequisites

- Go 1.21+
- Node.js (for npm scripts)
- Podman or Docker

### Run Locally (Development)

```bash
# Build and run directly with Go
npm run build
npm run run

# Or use Go commands directly
go build -o fetchfido .
./fetchfido
```

The application will be available at:
- Web UI: http://127.0.0.1:8080
- UDP Listener: 127.0.0.1:9999

### Run with Container

```bash
# Build and run container
npm run dev

# Or step by step:
npm run container:build
npm run container:run
```

## Sending GPS Data

Send GPS coordinates to the UDP port (default: 9999):

```bash
# Using netcat (JSON format)
echo '{"lat": 40.7128, "lon": -74.0060}' | nc -u localhost 9999

# Using Python
python test_gps.py

# Comma-separated format
echo "40.7128,-74.0060" | nc -u localhost 9999
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Web UI with GPS map and message list |
| `/health` | GET | Health check endpoint (JSON) |
| `/info` | GET | Service information (JSON) |
| `/messages` | GET | All received messages as JSON, most recent first |
| `/events` | GET | Server-sent event stream; emits `seq` when a message is stored |
| `/gps-data.js` | GET | GPS data as JavaScript (template), oldest first for the map track |
| `/static/*` | GET | Static assets (CSS, JS) |

## Tracker payload formats

The tracker sends one UDP datagram per fix, plain ASCII, comma-separated, no
trailing newline. Both lengths below are accepted, so the device can be switched
between them — in either direction — without coordinating a deployment. The full
wire format is documented in `PROTOCOL.md` in the FidoArduino repository.

```
33.551746,-101.902097                       # 2 fields: lat, lon
33.551746,-101.902097,1754160183,2.0,12     # 5 fields: + epoch, confidence, satellites
```

The first two fields are byte-identical in both formats.

| # | Field | Notes |
|---|-------|-------|
| 3 | epoch | Unix seconds UTC, when the fix was **taken**, not when it was sent. `0` means the device had no clock; it is shown as unknown, never as 1970-01-01. |
| 4 | confidence | Estimated horizontal error in metres, lower is better. Reads optimistically in poor conditions, so it is not a radius to draw. |
| 5 | satellites | Total satellites seen, **not** the number with a usable signal. |

Datagrams are rejected and dropped when they have fewer than 2 fields, contain
unparseable numbers, report `0,0` or out-of-range coordinates, or carry a
no-lock confidence value. The device's own `WIFI_TEST` / `CELLULAR_TEST` /
`STARTUP_TEST` diagnostic strings fail these checks by design.

### Ordering

The device buffers fixes when a send fails and replays up to 10 per cycle
afterwards, so **datagrams can arrive long after the moment they describe, and
out of order**. Messages are therefore ordered by capture time (field 3) where
it is known, falling back to arrival time for legacy payloads and for fixes
taken while the device had no clock.

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP/HTTPS server port |
| `LISTEN_PORT` | `9999` | UDP listener port |
| `LISTEN_IP` | `127.0.0.1` | Bind address for all listeners |
| `APP_VERSION` | `1.0.0` | Application version |
| `APP_ENV` | `development` | Environment name |
| `TLS_CERT_FILE` | - | Path to TLS certificate (enables HTTPS) |
| `TLS_KEY_FILE` | - | Path to TLS private key (enables HTTPS) |

## TLS/HTTPS Support

FetchFido supports TLS 1.3 for secure communication. See [TLS.md](TLS.md) for detailed configuration.

### Quick TLS Setup

```bash
# Generate self-signed certificate (testing only)
mkdir -p ./certs
openssl req -x509 -newkey rsa:4096 -keyout ./certs/privkey.pem \
  -out ./certs/fullchain.pem -days 365 -nodes -subj "/CN=localhost"

# Run with TLS
npm run container:run-tls
```

For production, use Let's Encrypt certificates. See [TLS.md](TLS.md) for instructions.

## Container Commands

### Basic Operations
```bash
npm run container:build          # Build container image
npm run container:run            # Run without TLS
npm run container:run-detached   # Run in background (HTTP)
npm run container:stop           # Stop running container
npm run container:clean          # Remove container
```

### TLS Operations
```bash
npm run container:run-tls              # Run with TLS
npm run container:run-tls-detached     # Run with TLS in background
```

### Kubernetes
```bash
npm run k8s:deploy               # Deploy to Kubernetes
npm run k8s:delete               # Remove from Kubernetes
```

## Project Structure

```
FetchFido/
├── main.go                 # Main application code
├── go.mod                  # Go module definition
├── Dockerfile              # Multi-stage container build
├── package.json            # npm scripts for convenience
├── TLS.md                  # TLS configuration guide
├── templates/
│   ├── index.html          # Main web UI template
│   └── gps-data.js         # GPS data JavaScript template
├── static/
│   ├── css/
│   │   └── style.css       # Application styles
│   └── js/
│       └── app.js          # Client-side JavaScript
└── test_gps.py             # GPS testing utility
```

## Security Features

- **Non-root User**: Container runs as UID/GID 65534
- **Scratch Base**: Minimal attack surface using scratch container
- **TLS 1.3 Only**: When TLS is enabled, only TLS 1.3 is accepted
- **Static Binary**: Fully static binary with no external dependencies
- **UPX Compression**: Binary compressed for minimal size
- **Read-only Mounts**: TLS certificates mounted read-only

## Development

### Testing GPS Functionality

```bash
# Basic GPS test
python test_gps.py

# Manual GPS testing
python test_manual_gps.py

# Verify GPS parsing
python verify_fix.py
```

### Building

```bash
# Build Go binary
go build -o fetchfido .

# Build optimized binary (like Docker build)
CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo \
  -ldflags '-extldflags "-static" -w -s' -trimpath -o fetchfido .
```

## Technology Stack

- **Backend**: Go 1.21+
- **Frontend**: HTML5, JavaScript, Leaflet.js 1.9.4
- **Container**: Podman/Docker (scratch-based)
- **Protocols**: HTTP/HTTPS, UDP

## License

MIT — see [LICENSE](LICENSE).

## Contributing

This project is designed for learning Podman/Kubernetes deployment. Contributions welcome!
