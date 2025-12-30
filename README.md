# Aryeo Delivery Runner

A production-ready service that automates the delivery of real estate media assets to Aryeo listings. The service accepts direct file URLs, validates them, and uses Playwright to import them into Aryeo via the "Import from link" UI flow.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   n8n       │────▶│   API       │────▶│   Redis     │
│  Workflow   │     │  (Fastify)  │     │  (BullMQ)   │
└─────────────┘     └─────────────┘     └──────┬──────┘
                          │                    │
                          ▼                    ▼
                   ┌─────────────┐     ┌─────────────┐
                   │  Evidence   │◀────│   Worker    │
                   │   Storage   │     │ (Playwright)│
                   └─────────────┘     └─────────────┘
                                              │
                                              ▼
                                       ┌─────────────┐
                                       │   Aryeo     │
                                       │    UI       │
                                       └─────────────┘
```

## Features

- **Direct URL Import**: Accepts per-file URLs and uses Aryeo's "Import from link" UI flow
- **Simple n8n Integration**: Accepts simple payload format with hyphenated keys from n8n
- **Async Job Processing**: Uses BullMQ for reliable job queuing with retries
- **Idempotency**: Prevents duplicate deliveries using auto-generated idempotency keys
- **URL Validation**: Validates all URLs via HEAD requests before automation
- **Evidence Collection**: Screenshots at every step for debugging
- **Security**: Bearer token auth, host allowlisting, HMAC-signed callbacks
- **Structured Logging**: JSON logs with Pino for easy parsing
- **Optional Delivery**: Can attach assets only or attach and deliver to client

## Prerequisites

- Node.js 20+
- Redis 7+
- Playwright dependencies (or use Docker)

## Quick Start

### 1. Clone and Install

```bash
cd aryeo-delivery-runner
npm install
npx playwright install chromium
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your settings
```

Required environment variables:
- `RUNNER_AUTH_TOKEN`: Secure token for API authentication

### 3. Generate Aryeo Session

Run the interactive login script to save Aryeo session state:

```bash
npm run login
```

This opens a browser window. Log in to Aryeo manually. The session is saved to `./data/auth/aryeo-storage-state.json`.

### 4. Start Services (Development)

Terminal 1 - Redis:
```bash
docker run -p 6379:6379 redis:7-alpine
```

Terminal 2 - API:
```bash
npm run dev
```

Terminal 3 - Worker:
```bash
npm run dev:worker
```

### 5. Start Services (Production)

```bash
docker-compose up -d
```

## API Endpoints

### POST /deliver

Queue a new delivery job.

**Headers:**
```
Authorization: Bearer <RUNNER_AUTH_TOKEN>
Content-Type: application/json
```

**Simple Payload (Recommended for n8n):**
```json
{
  "floor-plans": [
    "https://cdn.virtualxposure.com/floor-plans/main-floor-imperial.png",
    "https://cdn.virtualxposure.com/floor-plans/main-floor-metric.png",
    "https://cdn.virtualxposure.com/floor-plans/second-floor-imperial.png",
    "https://cdn.virtualxposure.com/floor-plans/second-floor-metric.png"
  ],
  "rms": [
    "https://cdn.virtualxposure.com/rms/imperial.pdf",
    "https://cdn.virtualxposure.com/rms/metric.pdf"
  ],
  "virtual-tour": "https://youriguide.com/123_main_street",
  "listing": "https://app.aryeo.com/admin/listings/67890/edit"
}
```

**To deliver after attaching, add `?deliver=true` to the URL:**
```
POST /deliver?deliver=true
```

**Full Manifest (Optional - for advanced use):**
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
      "https://cdn.virtualxposure.com/floor-plans/main-floor-imperial.png",
      "https://cdn.virtualxposure.com/floor-plans/main-floor-metric.png"
    ],
    "rms_urls": [
      "https://cdn.virtualxposure.com/rms/imperial.pdf",
      "https://cdn.virtualxposure.com/rms/metric.pdf"
    ]
  },
  "callbacks": {
    "status_webhook_url": "https://your-n8n-instance/webhook/delivery-callback",
    "status_webhook_secret": "your-webhook-secret"
  },
  "rules": {
    "deliver_after_attach": true
  }
}
```

**Response:**
```json
{
  "run_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "queued"
}
```

### GET /status/:run_id

Get the status of a delivery run.

**Headers:**
```
Authorization: Bearer <RUNNER_AUTH_TOKEN>
```

**Response:**
```json
{
  "run_id": "550e8400-e29b-41d4-a716-446655440000",
  "idempotency_key": "aryeo:67890:1705317000000",
  "status": "succeeded",
  "created_at": "2024-01-15T10:30:00.000Z",
  "updated_at": "2024-01-15T10:35:00.000Z",
  "started_at": "2024-01-15T10:30:05.000Z",
  "completed_at": "2024-01-15T10:35:00.000Z",
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
    "delivered": false
  },
  "evidence": {
    "screenshots": [
      { "step": "navigate_to_listing", "path": "/data/evidence/run_id/...", "timestamp": "..." }
    ]
  }
}
```

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "version": "1.0.0"
}
```

### GET /evidence/:run_id/:filename

Download an evidence screenshot.

**Headers:**
```
Authorization: Bearer <RUNNER_AUTH_TOKEN>
```

## How It Works

### Import Flow

1. **Floor Plans**: For each floor plan URL:
   - Clicks "Add" button in Floor Plans row
   - Selects "From link" option
   - Pastes the URL
   - Checks "Set titles from filenames" checkbox
   - Clicks "Import"

2. **RMS/Files**: For each RMS URL:
   - Clicks "Add" button in Files row
   - Selects "From link" option
   - Pastes the URL
   - Clicks "Import"

3. **3D Content**:
   - Clicks "Add" button in 3D Content row
   - Fills in Content Title: "iGuide 3D Virtual Tour"
   - Fills in Content Link: tour URL
   - Selects Display Type: "Both (Branded + Unbranded)"
   - Clicks "Add Content"

4. **Save**: Clicks the Save button

5. **Deliver** (optional): If `deliver_after_attach=true`, clicks Deliver/Send to Client

## Rules Configuration

The `rules` object controls optional behavior:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `deliver_after_attach` | boolean | `false` | If `true`, clicks the deliver/send button after saving. If `false`, only attaches assets and saves. |

### Attach-Only Mode (Default)

When `deliver_after_attach` is `false` or omitted:
1. Opens listing edit URL
2. Imports floor plan images via "From link"
3. Imports RMS PDFs via "From link"
4. Adds 3D Content with iGuide tour
5. Saves changes
6. **Skips delivery step**
7. Returns `succeeded` with `actions.delivered = false`

### Attach + Deliver Mode

When `deliver_after_attach` is `true` (via query param `?deliver=true` or in manifest):
1. Opens listing edit URL
2. Imports floor plan images via "From link"
3. Imports RMS PDFs via "From link"
4. Adds 3D Content with iGuide tour
5. Saves changes
6. **Clicks deliver/send to client**
7. Returns `succeeded` with `actions.delivered = true`

## Callback Format

When a job completes (if `callbacks` was provided), the worker POSTs to the `status_webhook_url`:

**Headers:**
```
Content-Type: application/json
X-VX-Signature: <HMAC-SHA256 of body with status_webhook_secret>
X-VX-Timestamp: 2024-01-15T10:35:00.000Z
```

**Body (Success):**
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
    "delivered": false
  },
  "evidence": {
    "screenshots": [...]
  }
}
```

**Body (Failure):**
```json
{
  "run_id": "...",
  "idempotency_key": "...",
  "status": "failed",
  "error": {
    "code": "ASSET_VALIDATION_FAILED",
    "message": "URL validation failed: https://... returned 404",
    "retryable": false
  },
  "actions": {
    "imported_floorplans": false,
    "imported_rms": false,
    "added_3d_content": false,
    "saved": false,
    "delivered": false
  },
  "evidence": {...}
}
```

## Error Codes

| Code | Description | Retryable |
|------|-------------|-----------|
| `INVALID_MANIFEST` | Request body validation failed | No |
| `UNAUTHORIZED` | Invalid or missing bearer token | No |
| `HOST_NOT_ALLOWED` | URL host not in allowlist | No |
| `ASSET_VALIDATION_FAILED` | URL HEAD request failed (404, network error) | Yes |
| `ASSET_TYPE_MISMATCH` | Content-Type doesn't match expected type | No |
| `ARYEO_LOGIN_REQUIRED` | Session expired, re-run login script | No |
| `ARYEO_UI_SELECTOR_CHANGED` | Aryeo UI changed, update selectors | No |
| `ARYEO_IMPORT_FAILED` | Failed to import URL via "From link" | Yes |
| `ARYEO_3D_CONTENT_FAILED` | Failed to add 3D Content | Yes |
| `ARYEO_NAVIGATION_FAILED` | Failed to navigate to listing | Yes |
| `ARYEO_SAVE_FAILED` | Failed to save listing | Yes |
| `ARYEO_DELIVER_FAILED` | Failed to deliver/send to client | Yes (for timeouts) |

## Updating Aryeo Selectors

When Aryeo's UI changes, update the selectors in:

```
src/aryeo/selectors.ts
```

The selectors use Playwright's recommended locator patterns:
- `getByRole()` for buttons, links, inputs
- `getByText()` for text content
- `getByLabel()` for form inputs
- Semantic locators with fallbacks

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RUNNER_PORT` | No | `8080` | API server port |
| `RUNNER_AUTH_TOKEN` | Yes | - | Bearer token for API auth |
| `ALLOWED_HOSTS` | No | `cdn.virtualxposure.com,youriguide.com,app.aryeo.com` | Allowed URL hosts |
| `REDIS_URL` | No | `redis://localhost:6379` | Redis connection URL |
| `PLAYWRIGHT_HEADLESS` | No | `true` | Run browser headless |
| `PLAYWRIGHT_TIMEOUT_MS` | No | `60000` | Playwright operation timeout |
| `DATA_DIR` | No | `./data` | Data directory path |
| `LOG_LEVEL` | No | `info` | Logging level |

## Directory Structure

```
aryeo-delivery-runner/
├── src/
│   ├── server.ts          # Fastify API server
│   ├── worker.ts          # BullMQ job processor
│   ├── queue.ts           # Queue and Redis management
│   ├── types.ts           # TypeScript types and schemas
│   ├── config.ts          # Configuration loader
│   ├── logger.ts          # Pino logger setup
│   ├── security.ts        # Auth and HMAC utilities
│   ├── normalize.ts       # Payload normalization
│   ├── validate-urls.ts   # URL validation via HEAD requests
│   └── aryeo/
│       ├── playwright.ts  # Aryeo automation flow
│       └── selectors.ts   # UI selectors (update when UI changes)
├── scripts/
│   └── login-aryeo.ts     # Interactive login script
├── data/
│   ├── auth/              # Session storage state
│   └── evidence/          # Screenshots per run
├── docker-compose.yml
├── Dockerfile
└── README.md
```

## Example cURL Requests

### Simple Payload (Attach Only - Default)

```bash
curl -X POST http://localhost:8080/deliver \
  -H "Authorization: Bearer your-auth-token" \
  -H "Content-Type: application/json" \
  -d '{
    "floor-plans": [
      "https://cdn.virtualxposure.com/fp/main-imperial.png",
      "https://cdn.virtualxposure.com/fp/main-metric.png"
    ],
    "rms": [
      "https://cdn.virtualxposure.com/rms/imperial.pdf",
      "https://cdn.virtualxposure.com/rms/metric.pdf"
    ],
    "virtual-tour": "https://youriguide.com/123_main_street",
    "listing": "https://app.aryeo.com/admin/listings/67890/edit"
  }'
```

### Simple Payload (Attach + Deliver)

```bash
curl -X POST "http://localhost:8080/deliver?deliver=true" \
  -H "Authorization: Bearer your-auth-token" \
  -H "Content-Type: application/json" \
  -d '{
    "floor-plans": [
      "https://cdn.virtualxposure.com/fp/main-imperial.png",
      "https://cdn.virtualxposure.com/fp/main-metric.png"
    ],
    "rms": [
      "https://cdn.virtualxposure.com/rms/imperial.pdf",
      "https://cdn.virtualxposure.com/rms/metric.pdf"
    ],
    "virtual-tour": "https://youriguide.com/123_main_street",
    "listing": "https://app.aryeo.com/admin/listings/67890/edit"
  }'
```

### Check Status

```bash
curl http://localhost:8080/status/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer your-auth-token"
```

## Deployment

### Docker Compose (Recommended)

1. Copy `.env.example` to `.env` and configure
2. Generate Aryeo session locally: `npm run login`
3. Copy `./data/auth/aryeo-storage-state.json` to production
4. Run: `docker-compose up -d`

### Manual Deployment

1. Build: `npm run build`
2. Install production deps: `npm ci --omit=dev`
3. Start API: `node dist/server.js`
4. Start Worker: `node dist/worker.js`

### Session Management

The Aryeo session typically expires after some time. Monitor for `ARYEO_LOGIN_REQUIRED` errors and re-run the login script when needed.

For production, consider:
- Setting up session refresh automation
- Alerting on login failures
- Using a dedicated service account

## Troubleshooting

### "Session expired" errors
Re-run `npm run login` to generate a new session.

### "Selector not found" errors
Aryeo's UI may have changed. Inspect the UI and update `src/aryeo/selectors.ts`.

### URL validation failures
- Check that URLs are accessible (not behind auth)
- Verify hostnames are in `ALLOWED_HOSTS`
- Check content types match expected (images for floor plans, PDFs for RMS)

### Import failures
- Check the evidence screenshots for what the UI looked like
- The "From link" flow may have changed - update selectors

## License

Proprietary - Virtual Xposure
