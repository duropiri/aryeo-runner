import path from 'node:path';
import { Worker, type Job } from 'bullmq';
import { fetch } from 'undici';
import { getConfig, loadConfig } from './config.js';
import { logger, createChildLogger } from './logger.js';
import {
  getRedisConnection,
  getRunState,
  updateRunStatus,
  closeConnections,
} from './queue.js';
import { createCallbackHeaders } from './security.js';
import { validateAllUrls } from './validate-urls.js';
import { runDeliveryAutomation, type ActionsPerformed } from './aryeo/playwright.js';
import {
  RunStatus,
  ErrorCodes,
  type RunState,
  type CallbackPayload,
  type DeliveryError,
  type AssetCounts,
} from './types.js';

const QUEUE_NAME = 'aryeo-delivery';

interface JobData {
  run_id: string;
}

/**
 * Sends a callback to the n8n webhook with the run status
 */
async function sendCallback(runState: RunState): Promise<void> {
  // Skip callback if no webhook configured (simple payloads may not have callbacks)
  if (!runState.manifest.callbacks?.status_webhook_url) {
    logger.debug({ run_id: runState.run_id }, 'No callback URL configured, skipping callback');
    return;
  }

  const log = createChildLogger({ run_id: runState.run_id, step: 'callback' });
  const { status_webhook_url, status_webhook_secret } = runState.manifest.callbacks;

  const payload: CallbackPayload = {
    run_id: runState.run_id,
    idempotency_key: runState.idempotency_key,
    status: runState.status,
    error: runState.error,
    assets_found: runState.assets_found,
    actions: runState.actions,
    evidence: runState.evidence,
  };

  const bodyString = JSON.stringify(payload);
  const headers = createCallbackHeaders(bodyString, status_webhook_secret);

  try {
    log.info({ url: status_webhook_url }, 'Sending callback to n8n');

    const response = await fetch(status_webhook_url, {
      method: 'POST',
      headers,
      body: bodyString,
    });

    if (!response.ok) {
      log.warn(
        { status: response.status, statusText: response.statusText },
        'Callback request failed'
      );
    } else {
      log.info('Callback sent successfully');
    }
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : String(err) },
      'Failed to send callback'
    );
  }
}

/**
 * Processes a delivery job
 */
async function processDeliveryJob(job: Job<JobData>): Promise<void> {
  const { run_id } = job.data;
  const log = createChildLogger({ run_id, jobId: job.id });

  log.info('Starting delivery job processing');

  // Get current run state
  let runState = await getRunState(run_id);
  if (!runState) {
    log.error('Run state not found');
    throw new Error(`Run state not found for run_id: ${run_id}`);
  }

  const config = getConfig();
  const { manifest } = runState;

  // Determine if we should deliver after attaching
  const deliverAfterAttach = manifest.rules?.deliver_after_attach ?? false;
  log.info({ deliverAfterAttach }, 'Processing with deliver_after_attach setting');

  // Update status to running
  runState = (await updateRunStatus(run_id, RunStatus.RUNNING, {
    current_step: 'initializing',
  }))!;

  // Set up evidence directory
  const evidenceDir = path.join(config.dataDir, 'evidence', run_id);

  // Track actions performed
  let actions: ActionsPerformed = {
    imported_floorplans: false,
    imported_rms: false,
    added_3d_content: false,
    saved: false,
    delivered: false,
  };

  try {
    // Step 1: Validate all URLs (HEAD requests to check accessibility and content types)
    log.info('Validating asset URLs');
    await updateRunStatus(run_id, RunStatus.RUNNING, { current_step: 'validating_urls' });

    const validationResult = await validateAllUrls(
      manifest.sources.floorplan_urls,
      manifest.sources.rms_urls,
      manifest.sources.tour_3d_url,
      run_id
    );

    if (!validationResult.success) {
      throw validationResult.error;
    }

    // Asset counts from validation
    const assetCounts: AssetCounts = {
      floorplans: manifest.sources.floorplan_urls.length,
      rms: manifest.sources.rms_urls.length,
      tour_3d: 1,
    };

    // Update state with asset counts
    await updateRunStatus(run_id, RunStatus.RUNNING, {
      current_step: 'running_automation',
      assets_found: assetCounts,
    });

    // Step 2: Run Playwright automation with the manifest
    log.info({ deliverAfterAttach }, 'Starting Playwright automation');
    const automationResult = await runDeliveryAutomation(
      run_id,
      manifest,
      evidenceDir,
      { deliverAfterAttach }
    );

    // Update actions from automation result
    actions = automationResult.actions;

    if (!automationResult.success) {
      throw automationResult.error;
    }

    // Step 3: Mark as succeeded
    const completionMessage = actions.delivered
      ? 'Delivery completed successfully (assets attached and delivered)'
      : 'Delivery completed successfully (assets attached, delivery skipped)';
    log.info({ actions }, completionMessage);

    runState = (await updateRunStatus(run_id, RunStatus.SUCCEEDED, {
      current_step: 'completed',
      assets_found: assetCounts,
      actions,
    }))!;

    // Send success callback
    await sendCallback(runState);
  } catch (err) {
    // Handle failure
    const deliveryError: DeliveryError =
      err && typeof err === 'object' && 'code' in err
        ? (err as DeliveryError)
        : {
            code: ErrorCodes.INTERNAL_ERROR,
            message: err instanceof Error ? err.message : String(err),
            retryable: true,
          };

    log.error({ error: deliveryError, actions }, 'Delivery job failed');

    runState = (await updateRunStatus(run_id, RunStatus.FAILED, {
      error: deliveryError,
      current_step: 'failed',
      actions,
    }))!;

    // Send failure callback
    await sendCallback(runState);

    // Re-throw if retryable to trigger BullMQ retry
    if (deliveryError.retryable && job.attemptsMade < (job.opts.attempts ?? 3) - 1) {
      throw new Error(deliveryError.message);
    }
  }
}

/**
 * Starts the worker
 */
async function startWorker(): Promise<void> {
  // Load configuration
  loadConfig();

  logger.info('Starting Aryeo Delivery Worker');

  const connection = getRedisConnection();

  const worker = new Worker<JobData>(QUEUE_NAME, processDeliveryJob, {
    connection,
    concurrency: 1, // Process one job at a time (Playwright resource intensive)
    lockDuration: 300000, // 5 minutes lock
    stalledInterval: 60000, // Check for stalled jobs every minute
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, run_id: job.data.run_id }, 'Job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, run_id: job?.data.run_id, error: err.message },
      'Job failed'
    );
  });

  worker.on('error', (err) => {
    logger.error({ error: err.message }, 'Worker error');
  });

  worker.on('stalled', (jobId) => {
    logger.warn({ jobId }, 'Job stalled');
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal');

    await worker.close();
    await closeConnections();

    logger.info('Worker shut down gracefully');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('Worker is ready and waiting for jobs');
}

// Start the worker
startWorker().catch((err) => {
  logger.error({ error: err.message }, 'Failed to start worker');
  process.exit(1);
});
