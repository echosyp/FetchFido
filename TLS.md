# TLS Configuration for FetchFido

FetchFido supports TLS 1.3 encryption for secure HTTPS communication. The application can run with or without TLS.

## Quick Start with Let's Encrypt

### 1. Generate Let's Encrypt Certificate

```bash
# Install certbot if not already installed
# On Ubuntu/Debian: sudo apt install certbot
# On macOS: brew install certbot

# Generate certificate (replace example.com with your domain)
sudo certbot certonly --standalone -d example.com

# Certificates will be created in /etc/letsencrypt/live/example.com/
```

### 2. Copy Certificates to Project

```bash
# Create certs directory in your project
mkdir -p ./certs

# Copy certificates (adjust paths as needed)
sudo cp /etc/letsencrypt/live/example.com/fullchain.pem ./certs/
sudo cp /etc/letsencrypt/live/example.com/privkey.pem ./certs/
sudo chown $USER:$USER ./certs/*.pem
```

### 3. Run with TLS

```bash
# Build and run container with TLS
npm run container:build
npm run container:run-tls
```

## Environment Variables

- `TLS_CERT_FILE`: Path to TLS certificate file (e.g., `/certs/fullchain.pem`)
- `TLS_KEY_FILE`: Path to TLS private key file (e.g., `/certs/privkey.pem`)
- `PORT`: HTTPS port (default: 8080)
- `LISTEN_PORT`: UDP port for data reception (default: 9999)

## Container Commands

- `npm run container:run`: Run without TLS (HTTP only)
- `npm run container:run-tls`: Run with TLS (HTTPS)
- `npm run container:run-detached`: Run without TLS in background
- `npm run container:run-tls-detached`: Run with TLS in background

## Manual Certificate Generation for Testing

```bash
# Generate self-signed certificate for testing
openssl req -x509 -newkey rsa:4096 -keyout ./certs/privkey.pem -out ./certs/fullchain.pem -days 365 -nodes -subj "/CN=localhost"
```

## TLS Configuration Details

- **TLS Version**: Only TLS 1.3 is supported for maximum security
- **Certificate Format**: PEM format required
- **File Permissions**: Certificates should be readable by the container user
- **Volume Mounting**: Certificates are mounted read-only into `/certs/`

## Automatic Certificate Renewal

For production, set up automatic Let's Encrypt renewal:

```bash
# Add to crontab for automatic renewal
echo "0 12 * * * /usr/bin/certbot renew --quiet && cp /etc/letsencrypt/live/example.com/*.pem /path/to/fetchfido/certs/ && podman restart fetchfido" | crontab -
```