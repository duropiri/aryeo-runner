import path from 'node:path';
import fs from 'node:fs';
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
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: VERSION,
    };
  });

  // Readiness check - checks Redis connectivity and storage state file
  fastify.get('/ready', async (request, reply): Promise<ReadinessResponse> => {
    // Check Redis connectivity
    const redisConnected = await isRedisConnected();
    const redisStatus: 'ok' | 'error' = redisConnected ? 'ok' : 'error';

    // Check storage state file exists
    const storageStateExists = fs.existsSync(config.storageStatePath);
    const storageStateStatus: 'ok' | 'missing' = storageStateExists ? 'ok' : 'missing';

    // Determine overall status
    let status: 'ok' | 'degraded' | 'unhealthy' = 'ok';
    if (redisStatus === 'error') {
      status = 'unhealthy';
      reply.status(503);
    } else if (storageStateStatus === 'missing') {
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
