import { v4 as uuidv4 } from 'uuid';
import {
  SimplePayloadSchema,
  InternalManifestSchema,
  LegacyManifestSchema,
  type InternalManifest,
  type SimplePayload,
  ErrorCodes,
  type DeliveryError,
} from './types.js';
import { logger } from './logger.js';

/**
 * Extracts listing ID from an Aryeo listing URL
 */
function extractListingId(listingUrl: string): string {
  // URL format: https://app.aryeo.com/admin/listings/<id>/edit
  const match = listingUrl.match(/\/listings\/([^/]+)/);
  if (match && match[1]) {
    return match[1];
  }
  // Fallback: use last path segment before /edit
  const url = new URL(listingUrl);
  const parts = url.pathname.split('/').filter(Boolean);
  const editIndex = parts.indexOf('edit');
  if (editIndex > 0) {
    return parts[editIndex - 1] ?? 'unknown';
  }
  return 'unknown';
}

/**
 * Generates an idempotency key from the listing URL and timestamp
 */
function generateIdempotencyKey(listingUrl: string): string {
  const listingId = extractListingId(listingUrl);
  const timestamp = Date.now();
  return `aryeo:${listingId}:${timestamp}`;
}

/**
 * Normalizes a simple n8n payload to the internal manifest format
 */
function normalizeSimplePayload(payload: SimplePayload, options?: { deliver_after_attach?: boolean }): InternalManifest {
  const listingId = extractListingId(payload.listing);
  const runId = uuidv4();

  return {
    run_id: runId,
    idempotency_key: generateIdempotencyKey(payload.listing),
    submitted_at: new Date().toISOString(),
    aryeo: {
      listing_edit_url: payload.listing,
      listing_id: listingId,
    },
    sources: {
      tour_3d_url: payload['virtual-tour'],
      floorplan_urls: payload['floor-plans'],
      rms_urls: payload.rms,
    },
    callbacks: undefined,
    rules: {
      deliver_after_attach: options?.deliver_after_attach ?? false,
    },
  };
}

interface NormalizeResult {
  success: true;
  manifest: InternalManifest;
}

interface NormalizeError {
  success: false;
  error: DeliveryError;
}

type NormalizeOutcome = NormalizeResult | NormalizeError;

/**
 * Normalizes any incoming payload to the internal manifest format.
 * Supports:
 * - Simple n8n payload (with hyphenated keys)
 * - Array-wrapped simple payload (length 1)
 * - Legacy full manifest
 * - New internal manifest format
 */
export function normalizePayload(
  rawPayload: unknown,
  options?: { deliver_after_attach?: boolean }
): NormalizeOutcome {
  const log = logger.child({ component: 'normalize' });

  // Handle null/undefined
  if (!rawPayload) {
    return {
      success: false,
      error: {
        code: ErrorCodes.INVALID_MANIFEST,
        message: 'Payload is empty or null',
        retryable: false,
      },
    };
  }

  let payload = rawPayload;

  // Unwrap array if it's a single-item array
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return {
        success: false,
        error: {
          code: ErrorCodes.INVALID_MANIFEST,
          message: 'Payload array is empty',
          retryable: false,
        },
      };
    }
    if (payload.length > 1) {
      log.warn({ count: payload.length }, 'Payload array has multiple items, using first item');
    }
    payload = payload[0];
  }

  // Try parsing as simple n8n payload first (most common case)
  const simpleResult = SimplePayloadSchema.safeParse(payload);
  if (simpleResult.success) {
    log.info('Normalized simple n8n payload');
    const manifest = normalizeSimplePayload(simpleResult.data, options);
    return { success: true, manifest };
  }

  // Try parsing as internal manifest (already normalized)
  const internalResult = InternalManifestSchema.safeParse(payload);
  if (internalResult.success) {
    log.info('Payload is already in internal manifest format');
    return { success: true, manifest: internalResult.data };
  }

  // Try parsing as legacy manifest (with ZIP URLs)
  const legacyResult = LegacyManifestSchema.safeParse(payload);
  if (legacyResult.success) {
    const legacy = legacyResult.data;
    log.info('Converting legacy manifest format');

    // Convert legacy to internal format
    const manifest: InternalManifest = {
      run_id: legacy.run_id,
      idempotency_key: legacy.idempotency_key,
      submitted_at: legacy.submitted_at,
      aryeo: legacy.aryeo,
      sources: {
        tour_3d_url: legacy.sources.tour_3d_url,
        floorplan_urls: legacy.sources.floorplan_urls ?? [],
        rms_urls: legacy.sources.rms_urls ?? [],
      },
      callbacks: legacy.callbacks,
      rules: legacy.rules,
    };

    // If legacy format has ZIP URLs but no direct URLs, that's an error now
    if (manifest.sources.floorplan_urls.length === 0 && legacy.sources.floorplans_zip_url) {
      return {
        success: false,
        error: {
          code: ErrorCodes.INVALID_MANIFEST,
          message: 'ZIP URL format is no longer supported. Please provide direct file URLs.',
          retryable: false,
        },
      };
    }

    return { success: true, manifest };
  }

  // None of the schemas matched - build a helpful error message
  const errors: string[] = [];

  // Check what keys are present to give better error messages
  if (typeof payload === 'object' && payload !== null) {
    const keys = Object.keys(payload);

    if (keys.includes('floor-plans') || keys.includes('virtual-tour') || keys.includes('listing')) {
      // Looks like a simple payload with issues
      errors.push(`Simple payload validation failed: ${simpleResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`);
    } else if (keys.includes('run_id') || keys.includes('aryeo')) {
      // Looks like a full manifest with issues
      errors.push(`Manifest validation failed: ${internalResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`);
    } else {
      errors.push('Payload does not match any known format');
      errors.push(`Expected keys for simple payload: floor-plans, rms, virtual-tour, listing`);
      errors.push(`Received keys: ${keys.join(', ')}`);
    }
  } else {
    errors.push(`Invalid payload type: ${typeof payload}`);
  }

  log.warn({ errors }, 'Failed to normalize payload');

  return {
    success: false,
    error: {
      code: ErrorCodes.INVALID_MANIFEST,
      message: errors.join('; '),
      retryable: false,
    },
  };
}

/**
 * Validates that all URLs in the manifest are from allowed hosts
 */
export function validateManifestHosts(
  manifest: InternalManifest,
  allowedHosts: string[]
): { valid: true } | { valid: false; disallowedUrl: string } {
  const allUrls = [
    manifest.aryeo.listing_edit_url,
    manifest.sources.tour_3d_url,
    ...manifest.sources.floorplan_urls,
    ...manifest.sources.rms_urls,
  ];

  for (const urlString of allUrls) {
    try {
      const url = new URL(urlString);
      const hostname = url.hostname.toLowerCase();

      const isAllowed = allowedHosts.some((allowed) => {
        return hostname === allowed || hostname.endsWith(`.${allowed}`);
      });

      if (!isAllowed) {
        return { valid: false, disallowedUrl: urlString };
      }
    } catch {
      return { valid: false, disallowedUrl: urlString };
    }
  }

  return { valid: true };
}
