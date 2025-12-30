# Aryeo Delivery Runner - Production Deployment Guide

This guide walks you through deploying the Aryeo Delivery Runner to production with HTTPS via Cloudflare.

## Quick Reference

| Endpoint | URL |
|----------|-----|
| Health Check | `GET https://runner.yourdomain.com/health` |
| Readiness Check | `GET https://runner.yourdomain.com/ready` |
| Deliver | `POST https://runner.yourdomain.com/deliver` |
| Status | `GET https://runner.yourdomain.com/status/:run_id` |

---

## Deployment Checklist

### Phase 1: Server Preparation

- [ ] Ubuntu 22.04 LTS VM provisioned
- [ ] SSH access configured
- [ ] Docker installed: `curl -fsSL https://get.docker.com | sh`
- [ ] Docker Compose installed: `sudo apt install docker-compose-plugin`
- [ ] Git installed: `sudo apt install git`

### Phase 2: Clone and Configure

```bash
# Clone the repository
git clone <your-repo-url> /opt/aryeo-runner
cd /opt/aryeo-runner

# Create environment file
cp .env.production .env

# Generate secure auth token
echo "RUNNER_AUTH_TOKEN=$(openssl rand -base64 32)" >> .env

# Edit configuration
nano .env
# Update: PUBLIC_BASE_URL, any other settings
```

### Phase 3: Aryeo Session State

```bash
# On your LOCAL machine (with browser), generate the session:
npm run login

# Copy the session file to the server:
scp ./data/auth/aryeo-storage-state.json user@server:/opt/aryeo-runner/data/auth/
```

### Phase 4: Build and Start Services

```bash
cd /opt/aryeo-runner

# Build Docker images
docker compose -f docker-compose.production.yml build

# Start services
docker compose -f docker-compose.production.yml up -d

# Check logs
docker compose -f docker-compose.production.yml logs -f
```

### Phase 5: Configure Cloudflare Tunnel (Option A - Recommended)

See [deploy/cloudflared/README.md](deploy/cloudflared/README.md) for detailed instructions.

```bash
# Quick setup:
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
cloudflared tunnel login
cloudflared tunnel create aryeo-runner
cloudflared tunnel route dns aryeo-runner runner.yourdomain.com

# Configure and start
sudo mkdir -p /etc/cloudflared
sudo cp deploy/cloudflared/config.yml /etc/cloudflared/
# Edit /etc/cloudflared/config.yml with your tunnel ID and hostname
sudo cp deploy/cloudflared/cloudflared.service /etc/systemd/system/
sudo systemctl enable --now cloudflared
```

### Phase 6: Verify Deployment

```bash
# Test health endpoint
curl https://runner.yourdomain.com/health

# Test readiness endpoint
curl https://runner.yourdomain.com/ready

# Test with auth (replace token)
curl -H "Authorization: Bearer YOUR_TOKEN" https://runner.yourdomain.com/ready
```

### Phase 7: Enable Live Delivery

```bash
# Once tested, disable safe mode
nano .env
# Set: SAFE_MODE=false

# Restart services
docker compose -f docker-compose.production.yml up -d
```

---

## n8n Integration

### HTTP Request Node Configuration

**Node Settings:**

| Setting | Value |
|---------|-------|
| Method | POST |
| URL | `https://runner.yourdomain.com/deliver` |
| Authentication | Header Auth |
| Header Name | `Authorization` |
| Header Value | `Bearer YOUR_RUNNER_AUTH_TOKEN` |
| Body Content Type | JSON |

**To attach + deliver, add query parameter:**
```
https://runner.yourdomain.com/deliver?deliver=true
```

### Sample Request Payload (Simple Format)

```json
{
  "floor-plans": [
    "https://cdn.virtualxposure.com/fp/main-floor-imperial.png",
    "https://cdn.virtualxposure.com/fp/main-floor-metric.png",
    "https://cdn.virtualxposure.com/fp/second-floor-imperial.png",
    "https://cdn.virtualxposure.com/fp/second-floor-metric.png"
  ],
  "rms": [
    "https://cdn.virtualxposure.com/rms/imperial.pdf",
    "https://cdn.virtualxposure.com/rms/metric.pdf"
  ],
  "virtual-tour": "https://youriguide.com/123_main_street",
  "listing": "https://app.aryeo.com/admin/listings/abc123/edit"
}
```

### Sample Request Payload (Full Format with Callback)

```json
{
  "run_id": "550e8400-e29b-41d4-a716-446655440000",
  "idempotency_key": "asana:12345:aryeo:67890",
  "submitted_at": "2024-01-15T10:30:00.000Z",
  "aryeo": {
    "listing_edit_url": "https://app.aryeo.com/admin/listings/67890/edit",
    "listing_id": "67890"
  },
  "sources": {
    "tour_3d_url": "https://youriguide.com/123_main_street",
    "floorplan_urls": [
      "https://cdn.virtualxposure.com/fp/main-floor-imperial.png",
      "https://cdn.virtualxposure.com/fp/main-floor-metric.png"
    ],
    "rms_urls": [
      "https://cdn.virtualxposure.com/rms/imperial.pdf",
      "https://cdn.virtualxposure.com/rms/metric.pdf"
    ]
  },
  "callbacks": {
    "status_webhook_url": "https://your-n8n.com/webhook/delivery-callback",
    "status_webhook_secret": "your-webhook-secret-here"
  },
  "rules": {
    "deliver_after_attach": true
  }
}
```

### Expected Response

**Success (200):**
```json
{
  "run_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "queued"
}
```

**Idempotent (200):**
```json
{
  "run_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "succeeded",
  "message": "Already completed successfully"
}
```

**Error (400/401/429):**
```json
{
  "error": {
    "code": "HOST_NOT_ALLOWED",
    "message": "Host not allowed: example.com"
  }
}
```

---

## Callback Signature Validation

The runner signs callbacks with HMAC-SHA256. The timestamp is **cryptographically bound** to the signature to prevent replay attacks.

### Signature Scheme

```
signature = HMAC-SHA256(secret, "${timestamp}.${rawBody}")
```

**Headers sent by the runner:**

| Header | Format | Example |
|--------|--------|---------|
| `X-VX-Timestamp` | Unix milliseconds (string) | `"1705317000000"` |
| `X-VX-Signature` | Hex-encoded HMAC-SHA256 | `"a1b2c3d4..."` |

**Verification requirements:**

1. **Timestamp freshness**: Reject callbacks older than **5 minutes** (300,000 ms)
2. **Signature validity**: Recompute `HMAC-SHA256(secret, "${timestamp}.${rawBody}")` and compare

### Webhook Node Setup

1. Create a Webhook node with path `/delivery-callback`
2. Set "HTTP Method" to POST
3. Connect to a Code node for signature validation

### Code Node: Validate Signature (Recommended)

Copy this into an n8n **Code node**. It handles timestamp validation, signature verification, and replay protection:

```javascript
// n8n Code Node: Validate Aryeo Runner Callback Signature
// This MUST be the first node after your Webhook node

const crypto = require('crypto');

// =============================================================================
// CONFIGURATION - Update this with your webhook secret
// =============================================================================
const WEBHOOK_SECRET = 'your-webhook-secret-here';
const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

// =============================================================================
// Extract headers and body
// =============================================================================
const headers = $input.first().json.headers;
const body = $input.first().json.body;

// Get signature headers (n8n lowercases header names)
const timestamp = headers['x-vx-timestamp'];
const signature = headers['x-vx-signature'];

// Get raw body - n8n parses JSON automatically, so we need to re-stringify
// IMPORTANT: This must match the exact byte-for-byte body the runner sent
const rawBody = JSON.stringify(body);

// =============================================================================
// Validate timestamp freshness (prevent replay attacks)
// =============================================================================
if (!timestamp) {
  throw new Error('Missing X-VX-Timestamp header');
}

const callbackTime = parseInt(timestamp, 10);
if (isNaN(callbackTime)) {
  throw new Error('Invalid X-VX-Timestamp format - expected Unix milliseconds');
}

const now = Date.now();
const age = now - callbackTime;

if (age > MAX_AGE_MS) {
  throw new Error(`Callback too old: ${Math.round(age / 1000)}s ago (max: ${MAX_AGE_MS / 1000}s)`);
}

if (age < -MAX_AGE_MS) {
  throw new Error('Callback timestamp is in the future - clock skew detected');
}

// =============================================================================
// Validate signature
// =============================================================================
if (!signature) {
  throw new Error('Missing X-VX-Signature header');
}

// Compute expected signature: HMAC-SHA256(secret, "${timestamp}.${rawBody}")
const signaturePayload = `${timestamp}.${rawBody}`;
const expectedSignature = crypto
  .createHmac('sha256', WEBHOOK_SECRET)
  .update(signaturePayload)
  .digest('hex');

// Timing-safe comparison
const signatureBuffer = Buffer.from(signature, 'hex');
const expectedBuffer = Buffer.from(expectedSignature, 'hex');

if (signatureBuffer.length !== expectedBuffer.length) {
  throw new Error('Invalid signature length');
}

if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
  throw new Error('Invalid signature - callback rejected');
}

// =============================================================================
// Signature valid! Return the validated payload
// =============================================================================
return {
  json: {
    validated: true,
    timestamp: new Date(callbackTime).toISOString(),
    run_id: body.run_id,
    idempotency_key: body.idempotency_key,
    status: body.status,
    error: body.error || null,
    assets_found: body.assets_found || null,
    actions: body.actions || null
  }
};
```

### Alternative: Function Node (Legacy)

If using a Function node instead of Code node:

```javascript
const crypto = require('crypto');

const WEBHOOK_SECRET = 'your-webhook-secret-here';
const MAX_AGE_MS = 5 * 60 * 1000;

// Get data from webhook
const timestamp = $input.first().json.headers['x-vx-timestamp'];
const signature = $input.first().json.headers['x-vx-signature'];
const body = $input.first().json.body;
const rawBody = JSON.stringify(body);

// Validate timestamp
const callbackTime = parseInt(timestamp, 10);
const age = Date.now() - callbackTime;
if (age > MAX_AGE_MS || age < -MAX_AGE_MS) {
  throw new Error('Callback timestamp out of range');
}

// Validate signature
const expected = crypto
  .createHmac('sha256', WEBHOOK_SECRET)
  .update(`${timestamp}.${rawBody}`)
  .digest('hex');

const sigBuf = Buffer.from(signature, 'hex');
const expBuf = Buffer.from(expected, 'hex');

if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
  throw new Error('Invalid signature');
}

return { json: { validated: true, ...body } };
```

---

## Callback Payload Examples

### Success Callback

**Headers:**
```
X-VX-Timestamp: 1705317000000
X-VX-Signature: a1b2c3d4e5f6...
Content-Type: application/json
```

**Body:**
```json
{
  "run_id": "550e8400-e29b-41d4-a716-446655440000",
  "idempotency_key": "aryeo:67890:1705317000000",
  "status": "succeeded",
  "assets_found": {
    "floorplans": 4,
    "rms": 2,
    "tour_3d": 1
  },
  "actions": {
    "imported_floorplans": true,
    "imported_rms": true,
    "added_3d_content": true,
    "saved": true,
    "delivered": true
  },
  "evidence": {
    "screenshots": [
      {
        "step": "navigate_to_listing",
        "path": "/app/data/evidence/550e.../navigate_success.png",
        "timestamp": "2024-01-15T10:30:05.000Z"
      }
    ]
  }
}
```

### Failure Callback

```json
{
  "run_id": "550e8400-e29b-41d4-a716-446655440000",
  "idempotency_key": "aryeo:67890:1705317000000",
  "status": "failed",
  "error": {
    "code": "ARYEO_LOGIN_REQUIRED",
    "message": "Session expired. Please re-run the login script.",
    "retryable": false
  },
  "actions": {
    "imported_floorplans": false,
    "imported_rms": false,
    "added_3d_content": false,
    "saved": false,
    "delivered": false
  },
  "evidence": {
    "screenshots": [...]
  }
}
```

---

## Monitoring & Maintenance

### Check Service Health

```bash
# Docker status
docker compose -f docker-compose.production.yml ps

# API health
curl https://runner.yourdomain.com/health

# Readiness (includes Redis check)
curl https://runner.yourdomain.com/ready
```

### View Logs

```bash
# All services
docker compose -f docker-compose.production.yml logs -f

# API only
docker compose -f docker-compose.production.yml logs -f api

# Worker only
docker compose -f docker-compose.production.yml logs -f worker
```

### Restart Services

```bash
docker compose -f docker-compose.production.yml restart
```

### Update Session State

When Aryeo session expires:

```bash
# On local machine
npm run login

# Copy to server
scp ./data/auth/aryeo-storage-state.json user@server:/opt/aryeo-runner/data/auth/

# Restart worker
docker compose -f docker-compose.production.yml restart worker
```

### View Evidence Screenshots

```bash
# List evidence
ls -la /opt/aryeo-runner/data/evidence/

# Or via API
curl -H "Authorization: Bearer TOKEN" \
  https://runner.yourdomain.com/evidence/{run_id}/{filename}
```

---

## Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| `ARYEO_LOGIN_REQUIRED` | Re-run `npm run login` and copy session to server |
| `HOST_NOT_ALLOWED` | Add hostname to `ALLOWED_HOSTS` in .env |
| `Connection refused` | Check Docker containers are running |
| `Rate limited` | Wait or increase `RATE_LIMIT_MAX_REQUESTS` |
| Worker OOM killed | Increase memory limits in docker-compose |
| `Callback timestamp out of range` | Check server clock sync (use NTP) |
| `Invalid signature` | Verify webhook secret matches in both runner and n8n |

### Debug Mode

```bash
# Set LOG_LEVEL=debug in .env
# Restart and watch logs
docker compose -f docker-compose.production.yml restart
docker compose -f docker-compose.production.yml logs -f worker
```
