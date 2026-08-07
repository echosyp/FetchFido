#!/usr/bin/env bash
#
# Build and deploy FetchFido to the container host.
#
# This exists because the deployment has a few settings that fail silently when
# forgotten:
#
#   LISTEN_IP=0.0.0.0   Without it the listener binds loopback inside the
#                       container. The server comes up, serves the dashboard,
#                       reports healthy - and receives no datagrams at all.
#   MAX_MESSAGES        Omitted, retention silently reverts to 100 and the
#                       buffer starts evicting hours of history.
#   DISPLAY_TZ          Omitted, timestamps silently revert to UTC.
#   ACK_ENABLED         Omitted, the device cannot distinguish "delivered" from
#                       "sent into a void" - which is exactly the failure that
#                       took hours to diagnose once already.
#
# The store is memory only, so a redeploy discards every fix it holds. This
# exports a CSV first; that export is the only copy.
#
# Usage:  ./deploy.sh [--no-export] [--dry-run]

set -euo pipefail

CONTAINER_HOST="${CONTAINER_HOST:-ssh://echosyp@10.10.120.11:22/run/user/1000/podman/podman.sock}"
SSH_HOST="${SSH_HOST:-saros}"
IMAGE="${IMAGE:-fetchfido:latest}"
NAME="${NAME:-fetchfido}"

WEB_PORT="${WEB_PORT:-8080}"
UDP_PORT="${UDP_PORT:-9998}"

LISTEN_IP="${LISTEN_IP:-0.0.0.0}"
MAX_MESSAGES="${MAX_MESSAGES:-5000}"
DISPLAY_TZ="${DISPLAY_TZ:-America/Chicago}"
DEFAULT_LIMIT="${DEFAULT_LIMIT:-250}"
ACK_ENABLED="${ACK_ENABLED:-true}"

# Optional. Both must be set for basic auth to engage; the server logs a warning
# when they are absent.
AUTH_USER="${AUTH_USER:-}"
AUTH_PASS="${AUTH_PASS:-}"

BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/fetchfido}"

export CONTAINER_HOST

do_export=1
dry_run=0
for arg in "$@"; do
  case "$arg" in
    --no-export) do_export=0 ;;
    --dry-run)   dry_run=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n== %s\n' "$*"; }

say "Preflight"
command -v podman >/dev/null || { echo "podman not found" >&2; exit 1; }
podman --remote info >/dev/null || { echo "cannot reach $CONTAINER_HOST" >&2; exit 1; }
echo "   container host reachable"

# Never ship a build that does not pass its own tests.
gofmt -l . | grep . && { echo "gofmt found unformatted files" >&2; exit 1; }
go vet ./...
go test ./...
echo "   fmt, vet and tests pass"

if [ "$dry_run" = 1 ]; then
  say "Dry run - stopping before any change"
  exit 0
fi

if [ "$do_export" = 1 ]; then
  say "Exporting the buffer (a redeploy discards it)"
  mkdir -p "$BACKUP_DIR"
  stamp=$(date +%Y-%m-%dT%H%M%S)
  out="$BACKUP_DIR/fetchfido-predeploy-$stamp.csv"
  if ssh -o BatchMode=yes "$SSH_HOST" \
       "curl -s --max-time 15 http://127.0.0.1:$WEB_PORT/export/csv" > "$out" 2>/dev/null \
     && [ -s "$out" ]; then
    echo "   $(( $(wc -l < "$out") - 1 )) rows -> $out"
  else
    rm -f "$out"
    echo "   nothing exported (service down, or auth now required)"
  fi
fi

say "Tagging the running image for rollback"
rollback="fetchfido:rollback-$(date +%Y-%m-%d-%H%M)"
if podman --remote image exists "$IMAGE"; then
  podman --remote tag "$IMAGE" "$rollback"
  echo "   $rollback"
else
  echo "   no existing image to tag"
  rollback=""
fi

say "Building"
podman --remote build -t "$IMAGE" .

say "Swapping the container"
podman --remote stop -t 5 "$NAME" >/dev/null 2>&1 || true
podman --remote rm "$NAME"        >/dev/null 2>&1 || true

auth_args=()
if [ -n "$AUTH_USER" ] && [ -n "$AUTH_PASS" ]; then
  auth_args=(-e "AUTH_USER=$AUTH_USER" -e "AUTH_PASS=$AUTH_PASS")
fi

podman --remote run -d \
  --name "$NAME" \
  -p "$WEB_PORT:8080" \
  -p "$UDP_PORT:$UDP_PORT/udp" \
  -e "LISTEN_IP=$LISTEN_IP" \
  -e "LISTEN_PORT=$UDP_PORT" \
  -e "MAX_MESSAGES=$MAX_MESSAGES" \
  -e "DEFAULT_LIMIT=$DEFAULT_LIMIT" \
  -e "DISPLAY_TZ=$DISPLAY_TZ" \
  -e "ACK_ENABLED=$ACK_ENABLED" \
  "${auth_args[@]}" \
  "$IMAGE" >/dev/null

say "Verifying"
sleep 3
podman --remote ps --filter "name=$NAME" --format '   {{.Names}}  {{.Status}}  {{.Ports}}'

# /health stays open even with auth on, which is what makes this check work
# without embedding credentials.
if ssh -o BatchMode=yes "$SSH_HOST" \
     "curl -sf --max-time 10 http://127.0.0.1:$WEB_PORT/health" >/dev/null; then
  echo "   health OK"
else
  echo "   HEALTH CHECK FAILED" >&2
  [ -n "$rollback" ] && echo "   roll back with: podman --remote run ... $rollback" >&2
  exit 1
fi

# Confirm the settings actually took, rather than trusting that they were passed.
say "Effective settings"
podman --remote logs "$NAME" 2>&1 \
  | grep -E "Timestamps displayed|Retaining up to|UDP listener started|Basic auth|no authentication" \
  | sed 's/^/   /'

say "Deployed"
[ -n "$rollback" ] && echo "   rollback image: $rollback"
