import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { getConfig } from './config.js';
import { logger } from './logger.js';
import type { Manifest, RunState, RunStatusType, ImportProgress } from './types.js';
import { RunStatus } from './types.js';

const QUEUE_NAME = 'aryeo-delivery';
const RUN_STATE_PREFIX = 'run:';
const IDEMPOTENCY_PREFIX = 'idempotency:';
const RUN_STATE_TTL = 60 * 60 * 24 * 7; // 7 days

let redisConnection: Redis | null = null;
let deliveryQueue: Queue | null = null;

/**
 * Gets the shared Redis connection
 */
export function getRedisConnection(): Redis {
  if (!redisConnection) {
    const config = getConfig();
    redisConnection = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null, // Required for BullMQ
      enableReadyCheck: false,
    });

    redisConnection.on('error', (err) => {
      logger.error({ err }, 'Redis connection error');
    });

    redisConnection.on('connect', () => {
      logger.info('Redis connected');
    });
  }
  return redisConnection;
}

/**
 * Gets the delivery queue instance
 */
export function getDeliveryQueue(): Queue {
  if (!deliveryQueue) {
    const connection = getRedisConnection();
    deliveryQueue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: {
          count: 100,
          age: 60 * 60 * 24, // 24 hours
        },
        removeOnFail: {
          count: 200,
          age: 60 * 60 * 24 * 7, // 7 days
        },
      },
    });

    logger.info({ queueName: QUEUE_NAME }, 'Delivery queue initialized');
  }
  return deliveryQueue;
}

/**
 * Stores a run state in Redis
 */
export async function setRunState(runState: RunState): Promise<void> {
  const redis = getRedisConnection();
  const key = `${RUN_STATE_PREFIX}${runState.run_id}`;
  const idempotencyKey = `${IDEMPOTENCY_PREFIX}${runState.idempotency_key}`;

  const pipeline = redis.pipeline();
  pipeline.setex(key, RUN_STATE_TTL, JSON.stringify(runState));
  pipeline.setex(idempotencyKey, RUN_STATE_TTL, runState.run_id);
  await pipeline.exec();

  logger.debug({ run_id: runState.run_id, status: runState.status }, 'Run state saved');
}

/**
 * Gets a run state by run_id
 */
export async function getRunState(runId: string): Promise<RunState | null> {
  const redis = getRedisConnection();
  const key = `${RUN_STATE_PREFIX}${runId}`;
  const data = await redis.get(key);

  if (!data) {
    return null;
  }

  return JSON.parse(data) as RunState;
}

/**
 * Gets a run_id by idempotency_key
 */
export async function getRunIdByIdempotencyKey(idempotencyKey: string): Promise<string | null> {
  const redis = getRedisConnection();
  const key = `${IDEMPOTENCY_PREFIX}${idempotencyKey}`;
  return redis.get(key);
}

/**
 * Gets a run state by idempotency_key
 */
export async function getRunStateByIdempotencyKey(idempotencyKey: string): Promise<RunState | null> {
  const runId = await getRunIdByIdempotencyKey(idempotencyKey);
  if (!runId) {
    return null;
  }
  return getRunState(runId);
}

/**
 * Updates the status of a run
 */
export async function updateRunStatus(
  runId: string,
  status: RunStatusType,
  updates?: Partial<Pick<RunState, 'error' | 'assets_found' | 'evidence' | 'current_step' | 'actions' | 'current_step_detail' | 'progress'>>
): Promise<RunState | null> {
  const runState = await getRunState(runId);
  if (!runState) {
    return null;
  }

  const updatedState: RunState = {
    ...runState,
    ...updates,
    status,
    updated_at: new Date().toISOString(),
  };

  if (status === RunStatus.RUNNING && !runState.started_at) {
    updatedState.started_at = new Date().toISOString();
  }

  if (status === RunStatus.SUCCEEDED || status === RunStatus.FAILED) {
    updatedState.completed_at = new Date().toISOString();
  }

  await setRunState(updatedState);
  return updatedState;
}

/**
 * Updates progress details without changing status
 * This is a lightweight update for frequent progress changes
 */
export async function updateProgress(
  runId: string,
  stepDetail: string,
  progress: ImportProgress
): Promise<void> {
  const runState = await getRunState(runId);
  if (!runState) {
    logger.warn({ run_id: runId }, 'Cannot update progress for unknown run');
    return;
  }

  runState.current_step_detail = stepDetail;
  runState.progress = progress;
  runState.updated_at = new Date().toISOString();

  await setRunState(runState);

  logger.debug(
    {
      run_id: runId,
      stepDetail,
      section: progress.section,
      index: progress.index,
      total: progress.total,
      phase: progress.phase,
    },
    'Progress updated'
  );
}

/**
 * Adds an evidence screenshot to the run state
 */
export async function addEvidenceScreenshot(
  runId: string,
  step: string,
  path: string
): Promise<void> {
  const runState = await getRunState(runId);
  if (!runState) {
    logger.warn({ run_id: runId }, 'Cannot add evidence to unknown run');
    return;
  }

  runState.evidence.screenshots.push({
    step,
    path,
    timestamp: new Date().toISOString(),
  });
  runState.updated_at = new Date().toISOString();

  await setRunState(runState);
  logger.debug({ run_id: runId, step, path }, 'Evidence screenshot added');
}

/**
 * Creates a new run state and enqueues the job
 */
export async function createAndEnqueueRun(manifest: Manifest): Promise<RunState> {
  const now = new Date().toISOString();

  const runState: RunState = {
    run_id: manifest.run_id,
    idempotency_key: manifest.idempotency_key,
    status: RunStatus.QUEUED,
    manifest,
    created_at: now,
    updated_at: now,
    evidence: {
      screenshots: [],
    },
  };

  // Save the run state
  await setRunState(runState);

  // Add to queue
  const queue = getDeliveryQueue();
  await queue.add(
    'delivery',
    { run_id: manifest.run_id },
    {
      jobId: manifest.run_id, // Use run_id as job ID for deduplication
    }
  );

  logger.info({ run_id: manifest.run_id, idempotency_key: manifest.idempotency_key }, 'Run created and enqueued');

  return runState;
}

/**
 * Checks if Redis is connected and responding
 */
export async function isRedisConnected(): Promise<boolean> {
  try {
    const redis = getRedisConnection();
    const result = await redis.ping();
    return result === 'PONG';
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Redis health check failed');
    return false;
  }
}

/**
 * Gracefully closes connections
 */
export async function closeConnections(): Promise<void> {
  if (deliveryQueue) {
    await deliveryQueue.close();
    deliveryQueue = null;
  }
  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
  }
  logger.info('Queue connections closed');
}
