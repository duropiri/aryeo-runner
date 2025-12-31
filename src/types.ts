import { z } from 'zod';

// Error codes for the delivery runner
export const ErrorCodes = {
  INVALID_MANIFEST: 'INVALID_MANIFEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  HOST_NOT_ALLOWED: 'HOST_NOT_ALLOWED',
  ASSET_FETCH_FAILED: 'ASSET_FETCH_FAILED',
  ASSET_TYPE_MISMATCH: 'ASSET_TYPE_MISMATCH',
  ASSET_VALIDATION_FAILED: 'ASSET_VALIDATION_FAILED',
  ARYEO_LOGIN_REQUIRED: 'ARYEO_LOGIN_REQUIRED',
  ARYEO_UI_SELECTOR_CHANGED: 'ARYEO_UI_SELECTOR_CHANGED',
  ARYEO_IMPORT_FAILED: 'ARYEO_IMPORT_FAILED',
  ARYEO_3D_CONTENT_FAILED: 'ARYEO_3D_CONTENT_FAILED',
  ARYEO_NAVIGATION_FAILED: 'ARYEO_NAVIGATION_FAILED',
  ARYEO_SAVE_FAILED: 'ARYEO_SAVE_FAILED',
  ARYEO_DELIVER_FAILED: 'ARYEO_DELIVER_FAILED',
  RUN_NOT_FOUND: 'RUN_NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

// Run status values
export const RunStatus = {
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
} as const;

export type RunStatusType = (typeof RunStatus)[keyof typeof RunStatus];

// ============================================================================
// Simple n8n Payload Schema (what n8n sends)
// ============================================================================

// The simple payload that n8n sends (may be wrapped in an array)
export const SimplePayloadSchema = z.object({
  'floor-plans': z.array(z.string().url()).min(1),
  'rms': z.array(z.string().url()).min(1),
  'virtual-tour': z.string().url(),
  'listing': z.string().url(),
});

export type SimplePayload = z.infer<typeof SimplePayloadSchema>;

// ============================================================================
// Internal Normalized Manifest Schema
// ============================================================================

// Rules schema for optional behavior configuration
const RulesSchema = z
  .object({
    deliver_after_attach: z.boolean().optional().default(false),
  })
  .optional()
  .default({});

// Callbacks schema (optional for simple payloads)
const CallbacksSchema = z
  .object({
    status_webhook_url: z.string().url(),
    status_webhook_secret: z.string().min(1),
  })
  .optional();

// The normalized internal manifest used by the runner
export const InternalManifestSchema = z.object({
  run_id: z.string().uuid(),
  idempotency_key: z.string().min(1),
  submitted_at: z.string().datetime().optional(),
  aryeo: z.object({
    listing_edit_url: z.string().url(),
    listing_id: z.string().min(1),
  }),
  sources: z.object({
    tour_3d_url: z.string().url(),
    floorplan_urls: z.array(z.string().url()),
    rms_urls: z.array(z.string().url()),
  }),
  callbacks: CallbacksSchema,
  rules: RulesSchema,
});

export type InternalManifest = z.infer<typeof InternalManifestSchema>;

// Legacy full manifest schema (for backwards compatibility)
export const LegacyManifestSchema = z.object({
  run_id: z.string().uuid(),
  idempotency_key: z.string().min(1),
  submitted_at: z.string().datetime(),
  aryeo: z.object({
    listing_edit_url: z.string().url(),
    listing_id: z.string().min(1),
  }),
  sources: z.object({
    tour_3d_url: z.string().url(),
    floorplans_zip_url: z.string().url().optional(),
    rms_zip_url: z.string().url().optional(),
    floorplan_urls: z.array(z.string().url()).optional(),
    rms_urls: z.array(z.string().url()).optional(),
  }),
  callbacks: z.object({
    status_webhook_url: z.string().url(),
    status_webhook_secret: z.string().min(1),
  }),
  rules: RulesSchema,
});

export type LegacyManifest = z.infer<typeof LegacyManifestSchema>;

// Alias for backwards compatibility
export type Manifest = InternalManifest;
export const ManifestSchema = InternalManifestSchema;

// Evidence screenshot structure
export interface EvidenceScreenshot {
  step: string;
  path: string;
  timestamp: string;
}

// Asset counts for reporting
export interface AssetCounts {
  floorplans: number;
  rms: number;
  tour_3d: number;
}

// Error structure
export interface DeliveryError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

// Actions performed during the run
export interface ActionsPerformed {
  imported_floorplans: boolean;
  imported_rms: boolean;
  added_3d_content: boolean;
  saved: boolean;
  delivered: boolean;
}

// Run state stored in Redis
export interface RunState {
  run_id: string;
  idempotency_key: string;
  status: RunStatusType;
  manifest: InternalManifest;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
  error?: DeliveryError;
  assets_found?: AssetCounts;
  actions?: ActionsPerformed;
  evidence: {
    screenshots: EvidenceScreenshot[];
  };
  current_step?: string;
}

// Callback payload structure
export interface CallbackPayload {
  run_id: string;
  idempotency_key: string;
  status: RunStatusType;
  error?: DeliveryError;
  assets_found?: AssetCounts;
  actions?: ActionsPerformed;
  evidence: {
    screenshots: EvidenceScreenshot[];
  };
}

// API response types
export interface DeliverResponse {
  run_id: string;
  status: RunStatusType;
  message?: string;
}

export interface StatusResponse {
  run_id: string;
  idempotency_key: string;
  status: RunStatusType;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
  current_step?: string;
  error?: DeliveryError;
  assets_found?: AssetCounts;
  actions?: ActionsPerformed;
  evidence: {
    screenshots: EvidenceScreenshot[];
  };
}

export interface HealthResponse {
  status: 'ok';
  timestamp: string;
  version: string;
  storageState: 'ok' | 'missing';
  cookieCount: number;
}

// Configuration
export interface Config {
  port: number;
  authToken: string;
  allowedHosts: string[];
  redisUrl: string;
  playwrightHeadless: boolean;
  playwrightTimeout: number;
  dataDir: string;
  storageStatePath: string;
  // Production settings
  publicBaseUrl: string;
  callbackTimeoutMs: number;
  jobTimeoutMs: number;
  maxRetries: number;
  // Rate limiting
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  // Safe mode (disables actual delivery clicks)
  safeMode: boolean;
  // Trust proxy (for X-Forwarded-* headers behind Cloudflare/nginx)
  trustProxy: boolean;
}

// Extended health response for readiness checks
export interface ReadinessResponse {
  status: 'ok' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  checks: {
    redis: 'ok' | 'error';
    storageState: 'ok' | 'missing' | 'invalid' | 'expired';
  };
}

// Storage state API types
export interface StorageStateUploadResponse {
  ok: boolean;
  cookieCount: number;
  cookieNames: string[];
  updatedAt: string;
}

export interface StorageStateStatusResponse {
  exists: boolean;
  sizeBytes?: number;
  mtime?: string;
  cookieCount?: number;
  soonestExpiry?: string | null;
  domains?: string[];
  error?: string;
}

// Auth status response (GET /auth/status)
export interface AuthStatusResponse {
  storageState: 'ok' | 'missing';
  cookieCount: number;
  cookieNames: string[];
  lastModified: string | null;
  expiresAtEstimate: string | null;
}

// Cookie upload body (POST /auth/cookies) - aryeo-login output format
export interface CookieUploadBody {
  cookieHeader: string;
  xsrfHeader?: string;
  expiresAt?: string;
}

// Playwright storage state format
export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface PlaywrightStorageState {
  cookies: PlaywrightCookie[];
  origins?: Array<{
    origin: string;
    localStorage?: Array<{ name: string; value: string }>;
  }>;
}

// URL validation result
export interface UrlValidationResult {
  url: string;
  valid: boolean;
  contentType?: string;
  error?: string;
}
