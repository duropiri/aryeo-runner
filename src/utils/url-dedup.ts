/**
 * URL Normalization and Deduplication Utilities
 *
 * These utilities prevent duplicate file imports by:
 * 1. Normalizing URLs to a canonical form
 * 2. Deduplicating by normalized URL
 * 3. Deduplicating by decoded filename (same filename = same file)
 */

import { logger } from '../logger.js';

/**
 * Represents a normalized asset URL with metadata for deduplication
 */
export interface NormalizedAsset {
  originalUrl: string;
  normalizedUrl: string;
  decodedFilename: string;
  filenameForMatching: string; // lowercase, trimmed for comparison
}

/**
 * Result of deduplicating a list of URLs
 */
export interface DedupeResult {
  urls: string[];
  assets: NormalizedAsset[];
  duplicatesRemoved: number;
  duplicateDetails: Array<{
    droppedUrl: string;
    reason: 'duplicate_url' | 'duplicate_filename';
    keptUrl: string;
    filename?: string;
  }>;
}

/**
 * Normalizes a URL to a canonical form for comparison.
 *
 * Steps:
 * 1. Parse with new URL()
 * 2. Remove hash and search params
 * 3. Normalize pathname by collapsing multiple slashes to single
 * 4. Return origin + normalized pathname
 *
 * @param url - The URL to normalize
 * @returns The normalized URL string
 * @throws Error if the URL is invalid
 */
export function normalizeAssetUrl(url: string): string {
  const parsed = new URL(url);

  // Collapse multiple slashes to single in pathname
  const normalizedPathname = parsed.pathname.replace(/\/{2,}/g, '/');

  // Return origin + normalized pathname (no hash, no search)
  return parsed.origin + normalizedPathname;
}

/**
 * Extracts and decodes the filename from a URL.
 *
 * @param url - The URL to extract the filename from
 * @returns The decoded filename, or empty string if not found
 */
export function extractDecodedFilename(url: string): string {
  try {
    const parsed = new URL(url);
    // Normalize pathname first
    const normalizedPathname = parsed.pathname.replace(/\/{2,}/g, '/');
    const segments = normalizedPathname.split('/').filter(Boolean);
    const lastSegment = segments[segments.length - 1] || '';

    if (!lastSegment) {
      return '';
    }

    // Decode URI component to handle %20, etc.
    return decodeURIComponent(lastSegment);
  } catch {
    // Fallback: try to extract from the end of the string
    const match = url.match(/\/([^/?#]+)(?:\?|#|$)/);
    if (match && match[1]) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }
    return '';
  }
}

/**
 * Creates a NormalizedAsset from a URL
 */
export function createNormalizedAsset(url: string): NormalizedAsset {
  const normalizedUrl = normalizeAssetUrl(url);
  const decodedFilename = extractDecodedFilename(url);
  const filenameForMatching = decodedFilename.toLowerCase().trim();

  return {
    originalUrl: url,
    normalizedUrl,
    decodedFilename,
    filenameForMatching,
  };
}

/**
 * Deduplicates a list of URLs by:
 * 1. First, normalizing each URL and removing exact duplicates
 * 2. Then, removing URLs that produce the same decoded filename
 *
 * Order is preserved; the first occurrence is kept.
 *
 * @param urls - The list of URLs to deduplicate
 * @param runId - Run ID for logging
 * @param assetType - Type of asset (for logging: 'floorplan' | 'rms')
 * @returns DedupeResult with deduplicated URLs and details
 */
export function deduplicateAssetUrls(
  urls: string[],
  runId: string,
  assetType: 'floorplan' | 'rms'
): DedupeResult {
  const log = logger.child({ run_id: runId, assetType, component: 'url-dedup' });

  const result: DedupeResult = {
    urls: [],
    assets: [],
    duplicatesRemoved: 0,
    duplicateDetails: [],
  };

  // Track what we've seen
  const seenNormalizedUrls = new Map<string, string>(); // normalizedUrl -> originalUrl
  const seenFilenames = new Map<string, string>(); // filenameForMatching -> originalUrl

  for (const url of urls) {
    try {
      const asset = createNormalizedAsset(url);

      // Check 1: Duplicate normalized URL?
      const existingByUrl = seenNormalizedUrls.get(asset.normalizedUrl);
      if (existingByUrl) {
        log.warn(
          {
            droppedUrl: url,
            keptUrl: existingByUrl,
            normalizedUrl: asset.normalizedUrl,
            reason: 'duplicate_url',
          },
          'Dropping duplicate URL (same normalized URL)'
        );
        result.duplicatesRemoved++;
        result.duplicateDetails.push({
          droppedUrl: url,
          reason: 'duplicate_url',
          keptUrl: existingByUrl,
        });
        continue;
      }

      // Check 2: Duplicate filename?
      if (asset.filenameForMatching) {
        const existingByFilename = seenFilenames.get(asset.filenameForMatching);
        if (existingByFilename) {
          log.warn(
            {
              droppedUrl: url,
              keptUrl: existingByFilename,
              filename: asset.decodedFilename,
              reason: 'duplicate_filename',
            },
            'Dropping duplicate URL (same decoded filename)'
          );
          result.duplicatesRemoved++;
          result.duplicateDetails.push({
            droppedUrl: url,
            reason: 'duplicate_filename',
            keptUrl: existingByFilename,
            filename: asset.decodedFilename,
          });
          continue;
        }
      }

      // Not a duplicate - add it
      seenNormalizedUrls.set(asset.normalizedUrl, url);
      if (asset.filenameForMatching) {
        seenFilenames.set(asset.filenameForMatching, url);
      }

      result.urls.push(url);
      result.assets.push(asset);
    } catch (err) {
      // Invalid URL - log warning but keep it (let validation catch it later)
      log.warn(
        { url, error: err instanceof Error ? err.message : String(err) },
        'Could not normalize URL - keeping original'
      );
      result.urls.push(url);
      result.assets.push({
        originalUrl: url,
        normalizedUrl: url,
        decodedFilename: '',
        filenameForMatching: '',
      });
    }
  }

  if (result.duplicatesRemoved > 0) {
    log.info(
      {
        originalCount: urls.length,
        deduplicatedCount: result.urls.length,
        duplicatesRemoved: result.duplicatesRemoved,
      },
      `Removed ${result.duplicatesRemoved} duplicate ${assetType} URL(s)`
    );
  }

  return result;
}

/**
 * Extracts the last path segment from a normalized URL for matching in the DOM
 * This is used as a fallback when filename matching fails
 */
export function extractUrlPathFragment(url: string): string {
  try {
    const normalized = normalizeAssetUrl(url);
    const parsed = new URL(normalized);
    const segments = parsed.pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] || '';
  } catch {
    // Fallback: extract last segment from the URL string
    const match = url.match(/\/([^/?#]+)(?:\?|#|$)/);
    return match?.[1] || '';
  }
}
