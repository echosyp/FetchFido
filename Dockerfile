# Build stage
FROM golang:1.26.1-alpine3.22 AS builder

# Install UPX for binary compression
RUN apk add --no-cache upx

# Set working directory
WORKDIR /app

# Copy go mod files
COPY go.mod ./

# Download dependencies and create go.sum
RUN go mod download

# Copy source code
COPY main.go ./
COPY templates/ ./templates/
COPY static/ ./static/

# Build the application with security flags and optimizations
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo \
    -ldflags '-extldflags "-static" -w -s' \
    -trimpath \
    -o fetchfido .

# Compress binary with UPX for maximum size reduction
RUN upx --best --lzma fetchfido

# Final stage - scratch (minimal possible image)
FROM scratch

# Copy the compressed binary from builder stage
COPY --from=builder /app/fetchfido /fetchfido

# Copy templates and static files
COPY --from=builder /app/templates /templates
COPY --from=builder /app/static /static

# Expose ports
EXPOSE 8080
EXPOSE 9998/udp

# Run as non-root user
USER 65534:65534

# Run the application
ENTRYPOINT ["/fetchfido"]