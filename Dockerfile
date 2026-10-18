# Self-hosted FetchFido: the API and the PWA in one static binary, in a scratch
# image, as a non-root user. Same shape as the earlier prototype on main.
#
# Build:  podman build -t fetchfido .
# Run:    podman run -d -p 8080:8080 -v fetchfido-data:/data fetchfido
#
# The database lives at /data/fetchfido.db; mount a volume there or the
# positions vanish with the container. See README.md for the environment.

FROM docker.io/library/golang:1.26.1-alpine3.22 AS builder

WORKDIR /src

# Dependencies first so they cache independently of the source.
COPY go.mod go.sum ./
RUN go mod download

COPY embed.go ./
COPY cmd/fetchfido ./cmd/fetchfido
COPY internal ./internal
COPY web ./web

# Pure Go throughout (modernc.org/sqlite has no C), so CGO stays off and the
# result is a fully static binary that needs nothing from an OS image.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/fetchfido ./cmd/fetchfido

# scratch has no mkdir, so the data directory is prepared here and copied in
# owned by the runtime user. 65534 is "nobody".
RUN mkdir -p /out/data && chown 65534:65534 /out/data

FROM scratch

COPY --from=builder /out/fetchfido /fetchfido
COPY --from=builder --chown=65534:65534 /out/data /data

# TLS roots are not needed: the server makes no outbound connections.

VOLUME ["/data"]
EXPOSE 8080

USER 65534:65534
ENTRYPOINT ["/fetchfido"]
