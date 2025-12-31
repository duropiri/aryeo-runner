import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import { getConfig, loadConfig } from './config.js';
import { logger } from './logger.js';
import { validateBearerToken } from './security.js';
import { normalizePayload, validateManifestHosts } from './normalize.js';
import {
  createAndEnqueueRun,
  getRunState,
  getRunStateByIdempotencyKey,
  closeConnections,
  isRedisConnected,
} from './queue.js';
import {
  ErrorCodes,
  RunStatus,
  type DeliverResponse,
  type StatusResponse,
  type HealthResponse,
  type ReadinessResponse,
  type StorageStateUploadResponse,
  type StorageStateStatusResponse,
  type AuthStatusResponse,
  type CookieUploadBody,
  type PlaywrightStorageState,
  type PlaywrightCookie,
} from './types.js';

const VERSION = '1.0.0';

// ============================================================================
// In-Memory Rate Limiter
// ============================================================================

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

class RateLimiter {
  private store: Map<string, RateLimitEntry> = new Map();
  private windowMs: number;
  private maxRequests: number;

  constructor(windowMs: number, maxRequests: number) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;

    // Cleanup expired entries every minute
    setInterval(() => this.cleanup(), 60000);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.resetTime < now) {
        this.store.delete(key);
      }
    }
  }

  isRateLimited(key: string): { limited: boolean; remaining: number; resetTime: number } {
    const now = Date.now();
    let entry = this.store.get(key);

    if (!entry || entry.resetTime < now) {
      entry = { count: 0, resetTime: now + this.windowMs };
      this.store.set(key, entry);
    }

    entry.count++;
    const remaining = Math.max(0, this.maxRequests - entry.count);
    const limited = entry.count > this.maxRequests;

    return { limited, remaining, resetTime: entry.resetTime };
  }
}

// ============================================================================
// Storage State Helpers
// ============================================================================

/**
 * Validates that an object is a valid Playwright storage state.
 */
function isValidStorageState(obj: unknown): obj is PlaywrightStorageState {
  if (!obj || typeof obj !== 'object') return false;
  const state = obj as Record<string, unknown>;

  if (!Array.isArray(state.cookies)) return false;

  for (const cookie of state.cookies) {
    if (!cookie || typeof cookie !== 'object') return false;
    const c = cookie as Record<string, unknown>;
    if (typeof c.name !== 'string' || !c.name) return false;
    if (typeof c.value !== 'string') return false;
    if (typeof c.domain !== 'string' || !c.domain) return false;
    if (typeof c.path !== 'string' || !c.path) return false;
  }

  return true;
}

/**
 * Gets the soonest expiry time from cookies (ignoring session cookies with -1 or 0).
 */
function getSoonestExpiry(cookies: PlaywrightCookie[]): Date | null {
  let soonest: Date | null = null;
  const now = Date.now();

  for (const cookie of cookies) {
    // Skip session cookies (expires -1 or 0 or undefined)
    if (cookie.expires === undefined || cookie.expires <= 0) continue;

    const expiryMs = cookie.expires * 1000;
    // Skip already expired cookies
    if (expiryMs < now) continue;

    const expiryDate = new Date(expiryMs);
    if (!soonest || expiryDate < soonest) {
      soonest = expiryDate;
    }
  }

  return soonest;
}

/**
 * Checks if any cookie is expired.
 */
function hasExpiredCookies(cookies: PlaywrightCookie[]): boolean {
  const now = Math.floor(Date.now() / 1000);
  for (const cookie of cookies) {
    // Skip session cookies
    if (cookie.expires === undefined || cookie.expires <= 0) continue;
    if (cookie.expires < now) return true;
  }
  return false;
}

/**
 * Extracts unique domains from cookies.
 */
function getUniqueDomains(cookies: PlaywrightCookie[]): string[] {
  const domains = new Set<string>();
  for (const cookie of cookies) {
    domains.add(cookie.domain);
  }
  return [...domains].sort();
}

/**
 * Extracts unique cookie names from cookies.
 */
function getUniqueCookieNames(cookies: PlaywrightCookie[]): string[] {
  const names = new Set<string>();
  for (const cookie of cookies) {
    names.add(cookie.name);
  }
  return [...names].sort();
}

/**
 * Parses a cookie header string into Playwright cookie objects.
 * Cookie header format: "name1=value1; name2=value2; ..."
 */
function parseCookieHeader(cookieHeader: string, expiresAt?: string): PlaywrightCookie[] {
  const cookies: PlaywrightCookie[] = [];
  const pairs = cookieHeader.split(';').map((s) => s.trim()).filter((s) => s);

  // Calculate expires in Unix seconds if expiresAt is provided
  let expiresUnix: number | undefined;
  if (expiresAt) {
    try {
      const expiryDate = new Date(expiresAt);
      if (!isNaN(expiryDate.getTime())) {
        expiresUnix = Math.floor(expiryDate.getTime() / 1000);
      }
    } catch {
      // Ignore invalid date
    }
  }

  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;

    const name = pair.substring(0, eqIndex).trim();
    const value = pair.substring(eqIndex + 1).trim();

    if (!name) continue;

    // Determine httpOnly based on cookie name (best-effort)
    // aryeo_session should be httpOnly, XSRF-TOKEN should not be
    const isSessionCookie = name.toLowerCase().includes('session');
    const isXsrfCookie = name.toUpperCase().includes('XSRF');

    // Create cookie for .aryeo.com domain
    cookies.push({
      name,
      value,
      domain: '.aryeo.com',
      path: '/',
      expires: expiresUnix ?? -1, // -1 for session cookie if no expiry
      httpOnly: isSessionCookie && !isXsrfCookie,
      secure: true,
      sameSite: 'Lax',
    });

    // Also create for app.aryeo.com for better compatibility
    cookies.push({
      name,
      value,
      domain: 'app.aryeo.com',
      path: '/',
      expires: expiresUnix ?? -1,
      httpOnly: isSessionCookie && !isXsrfCookie,
      secure: true,
      sameSite: 'Lax',
    });
  }

  return cookies;
}

/**
 * Validates a CookieUploadBody.
 */
function isValidCookieUploadBody(obj: unknown): obj is CookieUploadBody {
  if (!obj || typeof obj !== 'object') return false;
  const body = obj as Record<string, unknown>;
  if (typeof body.cookieHeader !== 'string' || !body.cookieHeader.trim()) return false;
  if (body.xsrfHeader !== undefined && typeof body.xsrfHeader !== 'string') return false;
  if (body.expiresAt !== undefined && typeof body.expiresAt !== 'string') return false;
  return true;
}

/**
 * Reads and parses the storage state file.
 */
function readStorageState(filePath: string): PlaywrightStorageState | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    if (isValidStorageState(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Validates storage state for readiness check.
 * Returns: 'ok' | 'missing' | 'invalid' | 'expired'
 */
function validateStorageStateForReadiness(filePath: string): 'ok' | 'missing' | 'invalid' | 'expired' {
  if (!fs.existsSync(filePath)) {
    return 'missing';
  }

  const state = readStorageState(filePath);
  if (!state) {
    return 'invalid';
  }

  if (state.cookies.length === 0) {
    return 'invalid';
  }

  // Check if any essential cookies are expired
  if (hasExpiredCookies(state.cookies)) {
    return 'expired';
  }

  return 'ok';
}

/**
 * Writes storage state atomically (temp file + rename) with chmod 600.
 */
async function writeStorageStateAtomically(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write to temp file
  const tempPath = path.join(os.tmpdir(), `storage-state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

  try {
    fs.writeFileSync(tempPath, content, { mode: 0o600 });

    // Verify it's valid JSON
    JSON.parse(fs.readFileSync(tempPath, 'utf-8'));

    // Atomic rename
    fs.renameSync(tempPath, filePath);

    // Ensure permissions are correct on final file
    fs.chmodSync(filePath, 0o600);
  } catch (err) {
    // Cleanup temp file
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

// ============================================================================
// Request Types
// ============================================================================

interface StatusParams {
  run_id: string;
}

interface EvidenceParams {
  run_id: string;
  filename: string;
}

interface DeliverQuerystring {
  deliver?: string;
}

// ============================================================================
// Server Factory
// ============================================================================

async function createServer() {
  const config = getConfig();

  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV !== 'production'
          ? {
              target: 'pino-pretty',
              options: { colorize: true },
            }
          : undefined,
    },
    // Trust proxy headers when behind Cloudflare/nginx
    trustProxy: config.trustProxy,
    // Generate request IDs
    genReqId: () => `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  });

  // Initialize rate limiter
  const rateLimiter = new RateLimiter(config.rateLimitWindowMs, config.rateLimitMaxRequests);

  // Register CORS
  await fastify.register(cors, {
    origin: true,
  });

  // ============================================================================
  // Request Logging Hook
  // ============================================================================

  fastify.addHook('onRequest', async (request) => {
    // Log incoming request with client IP (respects X-Forwarded-For when trustProxy=true)
    logger.info(
      {
        reqId: request.id,
        method: request.method,
        url: request.url,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      },
      'Incoming request'
    );
  });

  fastify.addHook('onResponse', async (request, reply) => {
    logger.info(
      {
        reqId: request.id,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      },
      'Request completed'
    );
  });

  // ============================================================================
  // Rate Limiting Hook (for /deliver endpoint only)
  // ============================================================================

  fastify.addHook('preHandler', async (request, reply) => {
    // Only rate limit the /deliver endpoint
    if (request.url.startsWith('/deliver')) {
      const clientKey = request.ip; // Uses X-Forwarded-For when trustProxy=true
      const { limited, remaining, resetTime } = rateLimiter.isRateLimited(clientKey);

      reply.header('X-RateLimit-Limit', config.rateLimitMaxRequests);
      reply.header('X-RateLimit-Remaining', remaining);
      reply.header('X-RateLimit-Reset', Math.ceil(resetTime / 1000));

      if (limited) {
        logger.warn({ ip: request.ip, reqId: request.id }, 'Rate limit exceeded');
        reply.status(429).send({
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests. Please retry later.',
          },
        });
        return;
      }
    }
  });

  // ============================================================================
  // Health Check Endpoints
  // ============================================================================

  // Basic liveness check - always returns 200 if server is running
  fastify.get('/health', async (): Promise<HealthResponse> => {
    // Check storage state for health response
    const state = readStorageState(config.storageStatePath);
    const storageStateStatus: 'ok' | 'missing' = state && state.cookies.length > 0 ? 'ok' : 'missing';
    const cookieCount = state?.cookies.length ?? 0;

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: VERSION,
      storageState: storageStateStatus,
      cookieCount,
    };
  });

  // Readiness check - checks Redis connectivity and storage state file
  fastify.get('/ready', async (request, reply): Promise<ReadinessResponse> => {
    // Check Redis connectivity
    const redisConnected = await isRedisConnected();
    const redisStatus: 'ok' | 'error' = redisConnected ? 'ok' : 'error';

    // Check storage state file: exists, valid, not expired
    const storageStateStatus = validateStorageStateForReadiness(config.storageStatePath);

    // Determine overall status
    let status: 'ok' | 'degraded' | 'unhealthy' = 'ok';
    if (redisStatus === 'error') {
      status = 'unhealthy';
      reply.status(503);
    } else if (storageStateStatus !== 'ok') {
      status = 'degraded';
      reply.status(200); // Still operational, just can't run automation
    }

    return {
      status,
      timestamp: new Date().toISOString(),
      version: VERSION,
      checks: {
        redis: redisStatus,
        storageState: storageStateStatus,
      },
    };
  });

  // ============================================================================
  // POST /auth/storage-state - Upload Playwright storage state
  // ============================================================================

  fastify.post<{ Body: unknown }>(
    '/auth/storage-state',
    async (
      request: FastifyRequest<{ Body: unknown }>,
      reply: FastifyReply
    ): Promise<StorageStateUploadResponse | { error: { code: string; message: string } }> => {
      // Validate bearer token
      if (!validateBearerToken(request, reply)) {
        return reply as unknown as StorageStateUploadResponse;
      }

      const log = logger.child({ reqId: request.id, endpoint: '/auth/storage-state' });

      // Validate the body is a valid storage state
      if (!isValidStorageState(request.body)) {
        log.warn('Invalid storage state format');
        reply.status(400);
        return {
          error: {
            code: 'INVALID_STORAGE_STATE',
            message: 'Invalid storage state format. Expected { cookies: Array<{name, value, domain, path, ...}>, origins?: [...] }',
          },
        };
      }

      const storageState = request.body as PlaywrightStorageState;
      const cookieCount = storageState.cookies.length;
      const cookieNames = getUniqueCookieNames(storageState.cookies);

      if (cookieCount === 0) {
        log.warn('Storage state has no cookies');
        reply.status(400);
        return {
          error: {
            code: 'EMPTY_STORAGE_STATE',
            message: 'Storage state must contain at least one cookie',
          },
        };
      }

      // Write atomically
      try {
        const jsonContent = JSON.stringify(storageState, null, 2);
        await writeStorageStateAtomically(config.storageStatePath, jsonContent);

        const updatedAt = new Date().toISOString();
        log.info({ cookieCount, cookieNames }, 'Storage state updated successfully');

        return {
          ok: true,
          cookieCount,
          cookieNames,
          updatedAt,
        };
      } catch (err) {
        log.error({ error: err instanceof Error ? err.message : String(err) }, 'Failed to write storage state');
        reply.status(500);
        return {
          error: {
            code: 'WRITE_FAILED',
            message: 'Failed to write storage state file',
          },
        };
      }
    }
  );

  // ============================================================================
  // POST /auth/cookies - Upload cookies from aryeo-login output format
  // ============================================================================

  fastify.post<{ Body: unknown }>(
    '/auth/cookies',
    async (
      request: FastifyRequest<{ Body: unknown }>,
      reply: FastifyReply
    ): Promise<StorageStateUploadResponse | { error: { code: string; message: string } }> => {
      // Validate bearer token
      if (!validateBearerToken(request, reply)) {
        return reply as unknown as StorageStateUploadResponse;
      }

      const log = logger.child({ reqId: request.id, endpoint: '/auth/cookies' });

      // Validate the body
      if (!isValidCookieUploadBody(request.body)) {
        log.warn('Invalid cookie upload body');
        reply.status(400);
        return {
          error: {
            code: 'INVALID_BODY',
            message: 'Invalid body format. Expected { cookieHeader: string, xsrfHeader?: string, expiresAt?: string }',
          },
        };
      }

      const body = request.body as CookieUploadBody;

      // Parse cookie header into Playwright cookies
      const cookies = parseCookieHeader(body.cookieHeader, body.expiresAt);

      if (cookies.length === 0) {
        log.warn('No cookies parsed from cookieHeader');
        reply.status(400);
        return {
          error: {
            code: 'NO_COOKIES',
            message: 'Could not parse any cookies from cookieHeader',
          },
        };
      }

      // Create Playwright storage state
      const storageState: PlaywrightStorageState = {
        cookies,
        origins: [
          {
            origin: 'https://app.aryeo.com',
            localStorage: [],
          },
        ],
      };

      const cookieCount = cookies.length;
      const cookieNames = getUniqueCookieNames(cookies);

      // Write atomically
      try {
        const jsonContent = JSON.stringify(storageState, null, 2);
        await writeStorageStateAtomically(config.storageStatePath, jsonContent);

        const updatedAt = new Date().toISOString();
        log.info({ cookieCount, cookieNames }, 'Cookies converted and saved as storage state');

        return {
          ok: true,
          cookieCount,
          cookieNames,
          updatedAt,
        };
      } catch (err) {
        log.error({ error: err instanceof Error ? err.message : String(err) }, 'Failed to write storage state');
        reply.status(500);
        return {
          error: {
            code: 'WRITE_FAILED',
            message: 'Failed to write storage state file',
          },
        };
      }
    }
  );

  // ============================================================================
  // GET /auth/status - Get auth/storage state status
  // ============================================================================

  fastify.get(
    '/auth/status',
    async (request: FastifyRequest, reply: FastifyReply): Promise<AuthStatusResponse> => {
      // Validate bearer token
      if (!validateBearerToken(request, reply)) {
        return reply as unknown as AuthStatusResponse;
      }

      const filePath = config.storageStatePath;

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        return {
          storageState: 'missing',
          cookieCount: 0,
          cookieNames: [],
          lastModified: null,
          expiresAtEstimate: null,
        };
      }

      try {
        const stats = fs.statSync(filePath);
        const state = readStorageState(filePath);

        if (!state || state.cookies.length === 0) {
          return {
            storageState: 'missing',
            cookieCount: 0,
            cookieNames: [],
            lastModified: stats.mtime.toISOString(),
            expiresAtEstimate: null,
          };
        }

        const cookieNames = getUniqueCookieNames(state.cookies);
        const soonestExpiry = getSoonestExpiry(state.cookies);

        return {
          storageState: 'ok',
          cookieCount: state.cookies.length,
          cookieNames,
          lastModified: stats.mtime.toISOString(),
          expiresAtEstimate: soonestExpiry ? soonestExpiry.toISOString() : null,
        };
      } catch {
        return {
          storageState: 'missing',
          cookieCount: 0,
          cookieNames: [],
          lastModified: null,
          expiresAtEstimate: null,
        };
      }
    }
  );

  // ============================================================================
  // GET /auth/storage-state/status - Get storage state status
  // ============================================================================

  fastify.get(
    '/auth/storage-state/status',
    async (request: FastifyRequest, reply: FastifyReply): Promise<StorageStateStatusResponse> => {
      // Validate bearer token
      if (!validateBearerToken(request, reply)) {
        return reply as unknown as StorageStateStatusResponse;
      }

      const filePath = config.storageStatePath;

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        return {
          exists: false,
        };
      }

      try {
        const stats = fs.statSync(filePath);
        const state = readStorageState(filePath);

        if (!state) {
          return {
            exists: true,
            sizeBytes: stats.size,
            mtime: stats.mtime.toISOString(),
            error: 'File exists but is not valid JSON or has invalid structure',
          };
        }

        const soonestExpiry = getSoonestExpiry(state.cookies);
        const domains = getUniqueDomains(state.cookies);

        return {
          exists: true,
          sizeBytes: stats.size,
          mtime: stats.mtime.toISOString(),
          cookieCount: state.cookies.length,
          soonestExpiry: soonestExpiry ? soonestExpiry.toISOString() : null,
          domains,
        };
      } catch (err) {
        return {
          exists: true,
          error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  );

  // ============================================================================
  // POST /deliver - Queue a new delivery
  // ============================================================================

  fastify.post<{ Body: unknown; Querystring: DeliverQuerystring }>(
    '/deliver',
    async (
      request: FastifyRequest<{ Body: unknown; Querystring: DeliverQuerystring }>,
      reply: FastifyReply
    ): Promise<DeliverResponse> => {
      // Validate bearer token
      if (!validateBearerToken(request, reply)) {
        return reply as unknown as DeliverResponse;
      }

      // Check for deliver_after_attach query parameter
      let deliverAfterAttach = request.query.deliver === 'true';

      // SAFE MODE: Force deliver_after_attach to false
      if (config.safeMode && deliverAfterAttach) {
        logger.warn({ reqId: request.id }, 'Safe mode enabled - forcing deliver_after_attach=false');
        deliverAfterAttach = false;
      }

      // Normalize the payload to internal manifest format
      const normalizeResult = normalizePayload(request.body, {
        deliver_after_attach: deliverAfterAttach,
      });

      if (!normalizeResult.success) {
        logger.warn({ error: normalizeResult.error, reqId: request.id }, 'Failed to normalize payload');
        reply.status(400);
        return {
          run_id: '',
          status: RunStatus.FAILED,
          message: normalizeResult.error.message,
        };
      }

      const manifest = normalizeResult.manifest;
      const log = logger.child({
        run_id: manifest.run_id,
        idempotency_key: manifest.idempotency_key,
        reqId: request.id,
      });

      // Validate all URLs are from allowed hosts
      const hostValidation = validateManifestHosts(manifest, config.allowedHosts);
      if (!hostValidation.valid) {
        const disallowedUrl = hostValidation.disallowedUrl;
        let hostname: string;
        try {
          hostname = new URL(disallowedUrl).hostname;
        } catch {
          hostname = disallowedUrl;
        }

        log.warn({ disallowedUrl, hostname }, 'Host not in allowlist');
        reply.status(400);
        return {
          run_id: manifest.run_id,
          status: RunStatus.FAILED,
          message: `Host not allowed: ${hostname}`,
        };
      }

      // Check idempotency - see if this key already exists
      const existingRun = await getRunStateByIdempotencyKey(manifest.idempotency_key);

      if (existingRun) {
        log.info(
          { existing_run_id: existingRun.run_id, status: existingRun.status },
          'Idempotency key already exists'
        );

        // If completed successfully, return success immediately (no-op)
        if (existingRun.status === RunStatus.SUCCEEDED) {
          return {
            run_id: existingRun.run_id,
            status: existingRun.status,
            message: 'Already completed successfully',
          };
        }

        // If still queued or running, return current status
        if (existingRun.status === RunStatus.QUEUED || existingRun.status === RunStatus.RUNNING) {
          return {
            run_id: existingRun.run_id,
            status: existingRun.status,
            message: 'Already in progress',
          };
        }

        // If failed, allow retry with same idempotency key but different run_id
        log.info('Previous run failed, allowing retry');
      }

      // Create and enqueue the new run
      try {
        const runState = await createAndEnqueueRun(manifest);

        log.info(
          {
            floorplans: manifest.sources.floorplan_urls.length,
            rms: manifest.sources.rms_urls.length,
            deliver_after_attach: manifest.rules?.deliver_after_attach,
            safe_mode: config.safeMode,
          },
          'Delivery run created and enqueued'
        );

        return {
          run_id: runState.run_id,
          status: runState.status,
        };
      } catch (err) {
        log.error({ error: err instanceof Error ? err.message : String(err) }, 'Failed to create run');
        reply.status(500);
        return {
          run_id: manifest.run_id,
          status: RunStatus.FAILED,
          message: 'Failed to enqueue delivery job',
        };
      }
    }
  );

  // ============================================================================
  // GET /status/:run_id - Get status of a delivery run
  // ============================================================================

  fastify.get<{ Params: StatusParams }>(
    '/status/:run_id',
    async (
      request: FastifyRequest<{ Params: StatusParams }>,
      reply: FastifyReply
    ): Promise<StatusResponse | { error: { code: string; message: string } }> => {
      // Validate bearer token
      if (!validateBearerToken(request, reply)) {
        return reply as unknown as StatusResponse;
      }

      const { run_id } = request.params;
      const log = logger.child({ run_id, reqId: request.id });

      const runState = await getRunState(run_id);

      if (!runState) {
        log.warn('Run not found');
        reply.status(404);
        return {
          error: {
            code: ErrorCodes.RUN_NOT_FOUND,
            message: `Run not found: ${run_id}`,
          },
        };
      }

      return {
        run_id: runState.run_id,
        idempotency_key: runState.idempotency_key,
        status: runState.status,
        created_at: runState.created_at,
        updated_at: runState.updated_at,
        started_at: runState.started_at,
        completed_at: runState.completed_at,
        current_step: runState.current_step,
        error: runState.error,
        assets_found: runState.assets_found,
        actions: runState.actions,
        evidence: runState.evidence,
      };
    }
  );

  // ============================================================================
  // GET /evidence/:run_id/:filename - Download evidence screenshot
  // ============================================================================

  fastify.get<{ Params: EvidenceParams }>(
    '/evidence/:run_id/:filename',
    async (request: FastifyRequest<{ Params: EvidenceParams }>, reply: FastifyReply) => {
      // Validate bearer token
      if (!validateBearerToken(request, reply)) {
        return;
      }

      const { run_id, filename } = request.params;
      const log = logger.child({ run_id, filename, reqId: request.id });

      // Validate run exists
      const runState = await getRunState(run_id);
      if (!runState) {
        log.warn('Run not found');
        reply.status(404).send({ error: { code: ErrorCodes.RUN_NOT_FOUND, message: 'Run not found' } });
        return;
      }

      // Validate filename is safe (no path traversal)
      if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        log.warn('Invalid filename');
        reply.status(400).send({ error: { code: 'INVALID_FILENAME', message: 'Invalid filename' } });
        return;
      }

      const evidencePath = path.join(config.dataDir, 'evidence', run_id, filename);

      // Check if file exists
      if (!fs.existsSync(evidencePath)) {
        log.warn('Evidence file not found');
        reply.status(404).send({ error: { code: 'FILE_NOT_FOUND', message: 'Evidence file not found' } });
        return;
      }

      // Send the file
      reply.header('Content-Type', 'image/png');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(fs.createReadStream(evidencePath));
    }
  );

  return fastify;
}

// ============================================================================
// Server Startup
// ============================================================================

async function startServer() {
  // Load configuration (will throw if missing required env vars)
  loadConfig();
  const config = getConfig();

  logger.info(
    {
      port: config.port,
      safeMode: config.safeMode,
      trustProxy: config.trustProxy,
      publicBaseUrl: config.publicBaseUrl,
    },
    'Starting Aryeo Delivery Runner API'
  );

  const fastify = await createServer();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal');

    await fastify.close();
    await closeConnections();

    logger.info('Server shut down gracefully');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await fastify.listen({ port: config.port, host: '0.0.0.0' });
    logger.info(`Server listening on port ${config.port}`);
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Failed to start server');
    process.exit(1);
  }
}

// Start the server
startServer();
