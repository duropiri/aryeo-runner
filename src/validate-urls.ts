import { fetch } from 'undici';
import { logger } from './logger.js';
import { ErrorCodes, type DeliveryError, type UrlValidationResult } from './types.js';

// Expected content types for each asset type
const FLOORPLAN_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/jpg'];
const RMS_CONTENT_TYPES = ['application/pdf'];

// Retry configuration
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

/**
 * Delays execution for a given number of milliseconds
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Validates a single URL by checking it returns 200 and has expected content type
 */
async function validateSingleUrl(
  url: string,
  expectedContentTypes: string[],
  runId: string
): Promise<UrlValidationResult> {
  const log = logger.child({ run_id: runId, url });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      log.debug({ attempt }, 'Validating URL');

      // Use HEAD request first (faster), fall back to GET if needed
      let response = await fetch(url, {
        method: 'HEAD',
        headers: {
          'User-Agent': 'AryeoDeliveryRunner/1.0',
        },
      });

      // Some servers don't support HEAD, try GET
      if (response.status === 405 || response.status === 501) {
        response = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'AryeoDeliveryRunner/1.0',
            'Range': 'bytes=0-0', // Request only first byte to minimize data transfer
          },
        });
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Check content type
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      const baseContentType = contentType.split(';')[0]?.trim() ?? '';

      const isValidType = expectedContentTypes.some((expected) =>
        baseContentType.includes(expected) || baseContentType === expected
      );

      if (!isValidType) {
        log.warn({ contentType, expectedContentTypes }, 'Content type mismatch');
        return {
          url,
          valid: false,
          contentType,
          error: `Expected content type ${expectedContentTypes.join(' or ')}, got ${contentType}`,
        };
      }

      log.debug({ contentType }, 'URL validated successfully');
      return {
        url,
        valid: true,
        contentType,
      };
    } catch (err) {
      log.warn({ attempt, error: err instanceof Error ? err.message : String(err) }, 'URL validation attempt failed');

      if (attempt < MAX_RETRIES) {
        await delay(RETRY_DELAY_MS);
      } else {
        return {
          url,
          valid: false,
          error: `Failed to validate URL after ${MAX_RETRIES} attempts: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  }

  // Should not reach here, but TypeScript needs this
  return {
    url,
    valid: false,
    error: 'Validation failed unexpectedly',
  };
}

/**
 * Validates all floorplan URLs
 */
export async function validateFloorplanUrls(
  urls: string[],
  runId: string
): Promise<UrlValidationResult[]> {
  const log = logger.child({ run_id: runId, type: 'floorplans', count: urls.length });
  log.info('Validating floorplan URLs');

  const results = await Promise.all(
    urls.map((url) => validateSingleUrl(url, FLOORPLAN_CONTENT_TYPES, runId))
  );

  const validCount = results.filter((r) => r.valid).length;
  log.info({ validCount, totalCount: urls.length }, 'Floorplan URL validation complete');

  return results;
}

/**
 * Validates all RMS URLs
 */
export async function validateRmsUrls(
  urls: string[],
  runId: string
): Promise<UrlValidationResult[]> {
  const log = logger.child({ run_id: runId, type: 'rms', count: urls.length });
  log.info('Validating RMS URLs');

  const results = await Promise.all(
    urls.map((url) => validateSingleUrl(url, RMS_CONTENT_TYPES, runId))
  );

  const validCount = results.filter((r) => r.valid).length;
  log.info({ validCount, totalCount: urls.length }, 'RMS URL validation complete');

  return results;
}

/**
 * Validates the tour URL (just checks it's accessible, any content type is OK)
 */
export async function validateTourUrl(
  url: string,
  runId: string
): Promise<UrlValidationResult> {
  const log = logger.child({ run_id: runId, type: 'tour' });
  log.info({ url }, 'Validating tour URL');

  // Tour URL can be any content type (it's a webpage)
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        headers: {
          'User-Agent': 'AryeoDeliveryRunner/1.0',
        },
      });

      // Accept 200-399 as valid (allows redirects)
      if (response.status >= 200 && response.status < 400) {
        log.info('Tour URL validated successfully');
        return {
          url,
          valid: true,
          contentType: response.headers.get('content-type') ?? undefined,
        };
      }

      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (err) {
      log.warn({ attempt, error: err instanceof Error ? err.message : String(err) }, 'Tour URL validation attempt failed');

      if (attempt < MAX_RETRIES) {
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  return {
    url,
    valid: false,
    error: `Failed to validate tour URL after ${MAX_RETRIES} attempts`,
  };
}

interface ValidationSuccess {
  success: true;
  counts: {
    floorplans: number;
    rms: number;
    tour_3d: number;
  };
}

interface ValidationFailure {
  success: false;
  error: DeliveryError;
  failedUrls: UrlValidationResult[];
}

type ValidationOutcome = ValidationSuccess | ValidationFailure;

/**
 * Validates all URLs in the manifest
 */
export async function validateAllUrls(
  floorplanUrls: string[],
  rmsUrls: string[],
  tourUrl: string,
  runId: string
): Promise<ValidationOutcome> {
  const log = logger.child({ run_id: runId });
  log.info(
    { floorplans: floorplanUrls.length, rms: rmsUrls.length },
    'Starting URL validation'
  );

  // Validate all URLs in parallel
  const [floorplanResults, rmsResults, tourResult] = await Promise.all([
    validateFloorplanUrls(floorplanUrls, runId),
    validateRmsUrls(rmsUrls, runId),
    validateTourUrl(tourUrl, runId),
  ]);

  // Collect all failed validations
  const failedUrls: UrlValidationResult[] = [
    ...floorplanResults.filter((r) => !r.valid),
    ...rmsResults.filter((r) => !r.valid),
  ];

  if (!tourResult.valid) {
    failedUrls.push(tourResult);
  }

  if (failedUrls.length > 0) {
    const errorMessages = failedUrls
      .map((f) => `${f.url}: ${f.error}`)
      .join('; ');

    // Determine if it's a type mismatch or fetch failure
    const hasTypeMismatch = failedUrls.some((f) => f.error?.includes('content type'));

    log.error({ failedCount: failedUrls.length, failedUrls }, 'URL validation failed');

    return {
      success: false,
      error: {
        code: hasTypeMismatch ? ErrorCodes.ASSET_TYPE_MISMATCH : ErrorCodes.ASSET_VALIDATION_FAILED,
        message: `URL validation failed: ${errorMessages}`,
        retryable: !hasTypeMismatch, // Type mismatches are not retryable
      },
      failedUrls,
    };
  }

  log.info('All URLs validated successfully');

  return {
    success: true,
    counts: {
      floorplans: floorplanUrls.length,
      rms: rmsUrls.length,
      tour_3d: 1,
    },
  };
}
