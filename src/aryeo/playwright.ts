import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { addEvidenceScreenshot, updateProgress } from '../queue.js';
import { ErrorCodes, type DeliveryError, type InternalManifest, type ImportPhase, type ImportSection, type ImportProgress } from '../types.js';
import {
  deduplicateAssetUrls,
  extractDecodedFilename,
  extractUrlPathFragment,
  type NormalizedAsset,
} from '../utils/url-dedup.js';
import {
  TEXT,
  TIMEOUTS,
  getMediaRow,
  getMediaRowCount,
  getAddButtonForRow,
  getFromLinkOption,
  getImportUrlInput,
  getImportButton,
  getCommitFilesButton,
  getUploadModal,
  get3DContentModal,
  getContentTitleInput,
  getContentLinkInput,
  getDisplayTypeDropdown,
  getAddContentButton,
  getSaveButton,
  getDeliverButton,
  getDeliverConfirmModal,
  getDeliverConfirmButton,
  getSuccessToast,
  getErrorToast,
  getUserMenu,
  waitForLoadingComplete,
  has3DContentWithTitle,
  // State-driven imports
  getUploadUIState,
  waitForAddButtonEnabled,
  waitForModalClose,
  formatUISnapshot,
  // Asset existence checks
  preflightAssetExists,
  waitForAssetExists,
  dumpUploadModalHtml,
  // Checkbox helper
  findAndCheckSetTitlesCheckbox,
  type AssetExistsResult,
} from './selectors.js';

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

/**
 * Automation step names for evidence tracking
 */
export const Steps = {
  NAVIGATE_TO_LISTING: 'navigate_to_listing',
  IMPORT_FLOORPLAN: 'import_floorplan',
  IMPORT_RMS: 'import_rms',
  ADD_3D_CONTENT: 'add_3d_content',
  SAVE_LISTING: 'save_listing',
  DELIVER_LISTING: 'deliver_listing',
  DELIVERY_CONFIRMED: 'delivery_confirmed',
  DELIVERY_SKIPPED: 'delivery_skipped',
  ERROR: 'error',
} as const;

interface AutomationContext {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  runId: string;
  evidenceDir: string;
}

/**
 * Baseline counts captured before imports
 */
interface BaselineCounts {
  floorPlans: number;
  files: number;
  threeDContent: number;
}

/**
 * Options for the automation run
 */
export interface AutomationOptions {
  deliverAfterAttach: boolean;
}

/**
 * Actions performed during automation
 */
export interface ActionsPerformed {
  imported_floorplans: boolean;
  imported_rms: boolean;
  added_3d_content: boolean;
  saved: boolean;
  delivered: boolean;
}

/**
 * Result of a successful automation run
 */
interface AutomationSuccessResult {
  success: true;
  actions: ActionsPerformed;
}

interface AutomationError {
  success: false;
  error: DeliveryError;
  actions: ActionsPerformed;
}

export type AutomationOutcome = AutomationSuccessResult | AutomationError;

/**
 * Delays execution for a given number of milliseconds
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Takes a screenshot and saves it as evidence
 */
async function takeScreenshot(
  ctx: AutomationContext,
  step: string,
  suffix?: string
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = suffix ? `${step}_${suffix}_${timestamp}.png` : `${step}_${timestamp}.png`;
  const screenshotPath = path.join(ctx.evidenceDir, filename);

  await ctx.page.screenshot({ path: screenshotPath, fullPage: true });
  await addEvidenceScreenshot(ctx.runId, step, screenshotPath);

  logger.debug({ run_id: ctx.runId, step, path: screenshotPath }, 'Screenshot taken');
  return screenshotPath;
}

/**
 * Checks if the user is logged in by looking for user menu
 */
async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const userMenu = getUserMenu(page);
    return await userMenu.isVisible({ timeout: 5000 });
  } catch {
    return false;
  }
}

/**
 * Captures baseline counts for Floor Plans, Files, and 3D Content
 */
async function captureBaselineCounts(
  ctx: AutomationContext
): Promise<BaselineCounts> {
  const log = logger.child({ run_id: ctx.runId, step: 'baseline_counts' });

  const floorPlans = await getMediaRowCount(ctx.page, TEXT.FLOOR_PLANS);
  const files = await getMediaRowCount(ctx.page, TEXT.FILES);
  const threeDContent = await getMediaRowCount(ctx.page, TEXT.THREE_D_CONTENT);

  log.info({ floorPlans, files, threeDContent }, 'Baseline counts captured');

  return { floorPlans, files, threeDContent };
}

/**
 * Creates a browser context with stored authentication state
 */
async function createAuthenticatedContext(): Promise<{
  browser: Browser;
  context: BrowserContext;
} | null> {
  const config = getConfig();
  const log = logger.child({ storageStatePath: config.storageStatePath });

  // Check if storage state file exists
  try {
    await fsp.access(config.storageStatePath, fs.constants.R_OK);
  } catch {
    log.error('Storage state file not found. Run the login script first.');
    return null;
  }

  const browser = await chromium.launch({
    headless: config.playwrightHeadless,
  });

  const context = await browser.newContext({
    storageState: config.storageStatePath,
  });

  // Set default timeouts
  context.setDefaultTimeout(config.playwrightTimeout);
  context.setDefaultNavigationTimeout(config.playwrightTimeout);

  return { browser, context };
}

/**
 * Navigates to the listing edit page and verifies it loaded
 *
 * STATE-DRIVEN: Uses page load states and observable UI elements
 * instead of fixed delays.
 */
async function navigateToListing(
  ctx: AutomationContext,
  listingEditUrl: string
): Promise<{ success: true } | { success: false; error: DeliveryError }> {
  const log = logger.child({ run_id: ctx.runId, step: Steps.NAVIGATE_TO_LISTING });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      log.info({ attempt, url: listingEditUrl }, 'Navigating to listing edit page');

      await ctx.page.goto(listingEditUrl, { waitUntil: 'domcontentloaded' });

      // STATE-DRIVEN: Wait for page to stabilize by checking for key elements
      // Instead of fixed delay, poll for the user menu to appear
      const pageReady = await waitForPageReady(ctx.page, 10000);

      if (!pageReady.loggedIn) {
        log.error('Not logged in after navigation');
        await takeScreenshot(ctx, Steps.NAVIGATE_TO_LISTING, 'not_logged_in');
        return {
          success: false,
          error: {
            code: ErrorCodes.ARYEO_LOGIN_REQUIRED,
            message: 'Session expired. Please re-run the login script.',
            retryable: false,
          },
        };
      }

      // Wait for loading indicators to clear
      await waitForLoadingComplete(ctx.page);

      // Verify we can see the Media section with expected rows
      const floorPlansRow = getMediaRow(ctx.page, TEXT.FLOOR_PLANS);
      await floorPlansRow.waitFor({ state: 'visible', timeout: TIMEOUTS.ELEMENT_VISIBLE });

      await takeScreenshot(ctx, Steps.NAVIGATE_TO_LISTING, 'success');
      log.info('Successfully navigated to listing edit page');
      return { success: true };
    } catch (err) {
      log.warn({ attempt, error: err instanceof Error ? err.message : String(err) }, 'Navigation attempt failed');

      await takeScreenshot(ctx, Steps.NAVIGATE_TO_LISTING, `error_attempt_${attempt}`);

      if (attempt < MAX_RETRIES) {
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  return {
    success: false,
    error: {
      code: ErrorCodes.ARYEO_NAVIGATION_FAILED,
      message: 'Failed to navigate to listing edit page after retries',
      retryable: true,
    },
  };
}

/**
 * Waits for the page to be ready by checking for login state and key elements
 */
async function waitForPageReady(
  page: Page,
  timeout: number
): Promise<{ ready: boolean; loggedIn: boolean }> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    // Check if user is logged in (user menu visible)
    const loggedIn = await isLoggedIn(page);

    if (loggedIn) {
      return { ready: true, loggedIn: true };
    }

    // Check for login redirect (if we're on a login page, we're not logged in)
    const url = page.url();
    if (url.includes('/login') || url.includes('/auth')) {
      return { ready: true, loggedIn: false };
    }

    await page.waitForTimeout(TIMEOUTS.STATE_POLL_INTERVAL);
  }

  // Timeout - check final state
  const loggedIn = await isLoggedIn(page);
  return { ready: loggedIn, loggedIn };
}

/**
 * Updates progress status for a specific import phase
 */
async function reportProgress(
  runId: string,
  section: ImportSection,
  index: number,
  total: number,
  phase: ImportPhase,
  filename?: string
): Promise<void> {
  const stepDetail = `${section}:index=${index} phase=${phase}`;
  const progress: ImportProgress = {
    section,
    index,
    total,
    phase,
    filename,
  };

  await updateProgress(runId, stepDetail, progress);
}

/**
 * Options for the unified import helper
 */
interface ImportViaUrlOptions {
  section: string;           // Row label (e.g., TEXT.FLOOR_PLANS or TEXT.FILES)
  sectionKey: ImportSection; // Section key for progress reporting
  asset: NormalizedAsset;    // Normalized asset with URL and filename
  setTitlesFromFilenames: boolean; // Whether to check the checkbox (floor plans only)
  step: string;              // Step name for evidence
  index: number;             // Index in the batch (for logging)
  total: number;             // Total items in batch
}

/**
 * Unified helper for importing a URL via "From link" flow and verifying attachment.
 *
 * IDEMPOTENT: Checks preflightAssetExists BEFORE importing.
 * ROBUST: Verifies by asset presence (not just count) with exponential backoff.
 * SAFE: After retry, re-checks preflight to prevent duplicate add.
 */
async function importViaUrlAndAttach(
  ctx: AutomationContext,
  options: ImportViaUrlOptions
): Promise<{ success: true; skipped?: boolean } | { success: false; error: DeliveryError }> {
  const { section, sectionKey, asset, setTitlesFromFilenames, step, index, total } = options;
  const { originalUrl, decodedFilename } = asset;
  const urlPathFragment = extractUrlPathFragment(originalUrl);

  const log = logger.child({
    run_id: ctx.runId,
    step,
    section,
    index,
    total,
    filename: decodedFilename,
    normalizedUrl: asset.normalizedUrl,
  });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // ═══════════════════════════════════════════════════════════════════════
      // PREFLIGHT CHECK: Does this asset already exist?
      // ═══════════════════════════════════════════════════════════════════════
      await reportProgress(ctx.runId, sectionKey, index, total, 'preflight_check', decodedFilename);

      const preflightResult = await preflightAssetExists(
        ctx.page,
        section,
        decodedFilename,
        urlPathFragment
      );

      if (preflightResult.exists) {
        log.info({
          preflightExists: true,
          matchMethod: preflightResult.matchMethod,
          matchedElement: preflightResult.matchedElement,
          attempt,
        }, 'Asset already exists in listing - SKIPPING import (idempotent)');

        await reportProgress(ctx.runId, sectionKey, index, total, 'skipped_exists', decodedFilename);
        return { success: true, skipped: true };
      }

      log.info({
        attempt,
        preflightExists: false,
      }, `Importing URL via "From link" for ${section}`);

      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 0: Open the import modal
      // ═══════════════════════════════════════════════════════════════════════
      await reportProgress(ctx.runId, sectionKey, index, total, 'modal_open', decodedFilename);

      // Click Add button for this row
      const addButton = getAddButtonForRow(ctx.page, section);
      await addButton.waitFor({ state: 'visible', timeout: TIMEOUTS.ELEMENT_VISIBLE });
      await addButton.click();
      log.debug('Clicked Add button');

      // Wait for and click "From link" option
      const fromLinkOption = getFromLinkOption(ctx.page);
      await fromLinkOption.waitFor({ state: 'visible', timeout: 5000 });
      await fromLinkOption.click();
      log.debug('Clicked "From link" option');

      // Fill the URL input
      const urlInput = getImportUrlInput(ctx.page);
      await urlInput.waitFor({ state: 'visible', timeout: 5000 });
      await urlInput.fill(originalUrl);
      log.debug('Filled URL input');

      // ═══════════════════════════════════════════════════════════════════════
      // Handle "Set titles from filenames" checkbox (ROBUST FIX)
      // ═══════════════════════════════════════════════════════════════════════
      if (setTitlesFromFilenames) {
        const checkboxResult = await findAndCheckSetTitlesCheckbox(ctx.page);

        if (!checkboxResult.success) {
          log.error({
            error: checkboxResult.error,
            modalHtml: checkboxResult.modalHtml?.substring(0, 500), // Truncate for logging
          }, 'FAILED to check "Set titles from filenames" checkbox');

          // Take screenshot with modal HTML dump
          await takeScreenshot(ctx, step, `checkbox_failed_${attempt}_${index}`);

          // Write modal HTML to file for debugging
          if (checkboxResult.modalHtml) {
            const htmlPath = path.join(ctx.evidenceDir, `checkbox_modal_${attempt}_${index}.html`);
            await fsp.writeFile(htmlPath, checkboxResult.modalHtml);
            log.debug({ htmlPath }, 'Modal HTML dumped for debugging');
          }

          throw new Error(`Checkbox interaction failed: ${checkboxResult.error}`);
        }

        log.info({
          method: checkboxResult.method,
          isChecked: checkboxResult.isChecked,
        }, '"Set titles from filenames" checkbox checked successfully');
      }

      // Click Import button to start server-side processing
      await reportProgress(ctx.runId, sectionKey, index, total, 'import_clicked', decodedFilename);

      const importButton = getImportButton(ctx.page);
      await importButton.waitFor({ state: 'visible', timeout: 5000 });
      await importButton.click();
      log.info('Clicked Import button - server-side processing started');

      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 1: Wait for Add button to become enabled (max 90s)
      // ═══════════════════════════════════════════════════════════════════════
      log.info('Phase 1: Waiting for Add button to become enabled...');

      const phase1Result = await waitForAddButtonEnabled(ctx.page, TIMEOUTS.ADD_BUTTON_ENABLED);

      if (!phase1Result.ready) {
        // Dump UI snapshot for diagnostics
        log.error({
          reason: phase1Result.reason,
          uiSnapshot: formatUISnapshot(phase1Result.state),
        }, 'Phase 1 failed: Add button did not become enabled');

        await takeScreenshot(ctx, step, `phase1_failed_attempt_${attempt}_${index}`);
        throw new Error(`Phase 1 failed: ${phase1Result.reason}`);
      }

      await reportProgress(ctx.runId, sectionKey, index, total, 'add_enabled', decodedFilename);
      log.info({
        addButtonText: phase1Result.state.addButtonText,
        uiSnapshot: formatUISnapshot(phase1Result.state),
      }, 'Phase 1 complete: Add button is enabled');

      // ═══════════════════════════════════════════════════════════════════════
      // CLICK THE ADD BUTTON
      // ═══════════════════════════════════════════════════════════════════════
      await reportProgress(ctx.runId, sectionKey, index, total, 'add_clicked', decodedFilename);

      const commitButton = getCommitFilesButton(ctx.page);
      log.info('Clicking Add button to attach file to listing...');
      await commitButton.click();
      log.debug('Clicked Add button');

      // Wait for modal to close
      log.info('Waiting for modal to close...');
      const modalClosed = await waitForModalClose(ctx.page, TIMEOUTS.MODAL_CLOSE);
      if (!modalClosed) {
        log.warn('Modal did not close within timeout - continuing to verification');
      } else {
        log.debug('Modal closed successfully');
      }

      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 2: Verify asset presence with exponential backoff (max 90s)
      // This verifies by ASSET PRESENCE, not just count!
      // ═══════════════════════════════════════════════════════════════════════
      await reportProgress(ctx.runId, sectionKey, index, total, 'verify', decodedFilename);
      log.info('Phase 2: Verifying asset presence (exponential backoff)...');

      const verifyResult = await waitForAssetExists(
        ctx.page,
        section,
        decodedFilename,
        urlPathFragment,
        TIMEOUTS.COUNT_VERIFICATION
      );

      if (verifyResult.exists) {
        log.info({
          matchMethod: verifyResult.matchMethod,
          matchedElement: verifyResult.matchedElement,
        }, 'Phase 2 complete: Asset VERIFIED in listing');
        await takeScreenshot(ctx, step, `success_${index}`);
        return { success: true };
      }

      // ═══════════════════════════════════════════════════════════════════════
      // VERIFICATION FALLBACK: Reload page and try again
      // ═══════════════════════════════════════════════════════════════════════
      log.warn('Asset not found after initial verification - attempting page reload');
      await ctx.page.reload({ waitUntil: 'networkidle' });
      await waitForLoadingComplete(ctx.page);

      // Re-run verification for up to 30s more
      const postReloadResult = await waitForAssetExists(
        ctx.page,
        section,
        decodedFilename,
        urlPathFragment,
        TIMEOUTS.POST_RELOAD_VERIFY
      );

      if (postReloadResult.exists) {
        log.info({
          matchMethod: postReloadResult.matchMethod,
          matchedElement: postReloadResult.matchedElement,
        }, 'Asset found after page reload - VERIFIED');
        await takeScreenshot(ctx, step, `success_after_reload_${index}`);
        return { success: true };
      }

      // Verification failed even after reload
      log.error({
        filename: decodedFilename,
        urlPathFragment,
      }, 'Phase 2 failed: Asset not visible even after page reload');

      // Check for error toast
      const errorToast = getErrorToast(ctx.page);
      if (await errorToast.isVisible()) {
        const errorText = await errorToast.textContent();
        throw new Error(`Import failed with error: ${errorText}`);
      }

      await takeScreenshot(ctx, step, `phase2_failed_attempt_${attempt}_${index}`);
      throw new Error(`Verification failed: Asset "${decodedFilename}" not visible in ${section} after import`);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn({
        attempt,
        error: errorMessage,
        filename: decodedFilename,
        normalizedUrl: asset.normalizedUrl,
      }, `Import attempt ${attempt}/${MAX_RETRIES} failed for ${section}`);

      // Capture UI state for diagnostics
      const uiState = await getUploadUIState(ctx.page);
      log.debug({ uiSnapshot: formatUISnapshot(uiState) }, 'UI state at failure');

      // Take screenshot on failure (include attempt number)
      await takeScreenshot(ctx, step, `error_attempt_${attempt}_${index}`);

      // Close any open modals before retry
      await closeOpenModals(ctx);

      if (attempt < MAX_RETRIES) {
        log.info(`Retrying import in ${RETRY_DELAY_MS}ms...`);
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  return {
    success: false,
    error: {
      code: ErrorCodes.ACTION_FAILED,
      message: `Failed to import URL for ${section} after ${MAX_RETRIES} retries: ${originalUrl}`,
      retryable: true,
    },
  };
}

/**
 * Closes any open modals by pressing Escape
 */
async function closeOpenModals(ctx: AutomationContext): Promise<void> {
  try {
    await ctx.page.keyboard.press('Escape');
    await ctx.page.waitForTimeout(300);
    await ctx.page.keyboard.press('Escape');
    await ctx.page.waitForTimeout(300);
  } catch {
    // Ignore
  }
}

/**
 * Result of importing multiple URLs
 */
interface BatchImportResult {
  success: boolean;
  error?: DeliveryError;
  successCount: number;
  skippedCount: number;
  totalCount: number;
  allVerified: boolean;
}

/**
 * Imports all floor plan URLs with proper verification.
 * Pre-deduplicates URLs before importing.
 * Returns allVerified=true ONLY if ALL non-skipped items were attached and verified.
 */
async function importFloorplans(
  ctx: AutomationContext,
  urls: string[]
): Promise<BatchImportResult> {
  const log = logger.child({ run_id: ctx.runId, section: 'floorplans' });

  if (urls.length === 0) {
    log.info('No floor plan URLs to import, skipping');
    return { success: true, successCount: 0, skippedCount: 0, totalCount: 0, allVerified: true };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRE-DEDUPE: Normalize and deduplicate URLs BEFORE Playwright
  // ═══════════════════════════════════════════════════════════════════════
  const dedupeResult = deduplicateAssetUrls(urls, ctx.runId, 'floorplan');

  log.info({
    originalCount: urls.length,
    deduplicatedCount: dedupeResult.urls.length,
    duplicatesRemoved: dedupeResult.duplicatesRemoved,
  }, 'Floor plan URLs deduplicated');

  if (dedupeResult.assets.length === 0) {
    log.info('All floor plan URLs were duplicates, nothing to import');
    return { success: true, successCount: 0, skippedCount: urls.length, totalCount: urls.length, allVerified: true };
  }

  log.info({ urls: dedupeResult.urls }, 'Starting floor plan imports');

  let successCount = 0;
  let skippedCount = 0;
  const total = dedupeResult.assets.length;

  for (let i = 0; i < dedupeResult.assets.length; i++) {
    const asset = dedupeResult.assets[i];
    if (!asset) continue;

    const result = await importViaUrlAndAttach(ctx, {
      section: TEXT.FLOOR_PLANS,
      sectionKey: 'floorplans',
      asset,
      setTitlesFromFilenames: true,
      step: Steps.IMPORT_FLOORPLAN,
      index: i,
      total,
    });

    if (!result.success) {
      log.error({ url: asset.originalUrl, index: i }, 'Floor plan import failed');
      return {
        success: false,
        error: result.error,
        successCount,
        skippedCount,
        totalCount: total,
        allVerified: false,
      };
    }

    if (result.skipped) {
      skippedCount++;
      log.info({ filename: asset.decodedFilename, index: i }, 'Floor plan skipped (already exists)');
    } else {
      successCount++;
      log.info({ successCount, skippedCount, total }, 'Floor plan imported successfully');
    }

    // Small delay between imports
    if (i < dedupeResult.assets.length - 1) {
      await delay(1000);
    }
  }

  // All items processed successfully
  const allVerified = successCount + skippedCount === total;

  log.info({
    successCount,
    skippedCount,
    total,
    allVerified,
  }, 'All floor plans processed');

  return {
    success: true,
    successCount,
    skippedCount,
    totalCount: total,
    allVerified,
  };
}

/**
 * Imports all RMS URLs (into the Files row) with proper verification.
 * Pre-deduplicates URLs before importing.
 * Returns allVerified=true ONLY if ALL non-skipped items were attached and verified.
 */
async function importRmsFiles(
  ctx: AutomationContext,
  urls: string[]
): Promise<BatchImportResult> {
  const log = logger.child({ run_id: ctx.runId, section: 'rms' });

  if (urls.length === 0) {
    log.info('No RMS URLs to import, skipping');
    return { success: true, successCount: 0, skippedCount: 0, totalCount: 0, allVerified: true };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRE-DEDUPE: Normalize and deduplicate URLs BEFORE Playwright
  // ═══════════════════════════════════════════════════════════════════════
  const dedupeResult = deduplicateAssetUrls(urls, ctx.runId, 'rms');

  log.info({
    originalCount: urls.length,
    deduplicatedCount: dedupeResult.urls.length,
    duplicatesRemoved: dedupeResult.duplicatesRemoved,
  }, 'RMS URLs deduplicated');

  if (dedupeResult.assets.length === 0) {
    log.info('All RMS URLs were duplicates, nothing to import');
    return { success: true, successCount: 0, skippedCount: urls.length, totalCount: urls.length, allVerified: true };
  }

  log.info({ urls: dedupeResult.urls }, 'Starting RMS file imports');

  let successCount = 0;
  let skippedCount = 0;
  const total = dedupeResult.assets.length;

  for (let i = 0; i < dedupeResult.assets.length; i++) {
    const asset = dedupeResult.assets[i];
    if (!asset) continue;

    const result = await importViaUrlAndAttach(ctx, {
      section: TEXT.FILES,
      sectionKey: 'rms',
      asset,
      setTitlesFromFilenames: false,
      step: Steps.IMPORT_RMS,
      index: i,
      total,
    });

    if (!result.success) {
      log.error({ url: asset.originalUrl, index: i }, 'RMS file import failed');
      return {
        success: false,
        error: result.error,
        successCount,
        skippedCount,
        totalCount: total,
        allVerified: false,
      };
    }

    if (result.skipped) {
      skippedCount++;
      log.info({ filename: asset.decodedFilename, index: i }, 'RMS file skipped (already exists)');
    } else {
      successCount++;
      log.info({ successCount, skippedCount, total }, 'RMS file imported successfully');
    }

    // Small delay between imports
    if (i < dedupeResult.assets.length - 1) {
      await delay(1000);
    }
  }

  // All items processed successfully
  const allVerified = successCount + skippedCount === total;

  log.info({
    successCount,
    skippedCount,
    total,
    allVerified,
  }, 'All RMS files processed');

  return {
    success: true,
    successCount,
    skippedCount,
    totalCount: total,
    allVerified,
  };
}

/**
 * Result of adding 3D content
 */
interface Add3DContentResult {
  success: boolean;
  verified: boolean;
  error?: DeliveryError;
}

/**
 * Adds 3D Content (iGuide tour) via the modal with proper verification.
 *
 * REQUIREMENTS:
 * - Title must ALWAYS be exactly: "iGuide 3D Virtual Tour"
 * - Display type must ALWAYS be: "Both (Branded + Unbranded)"
 * - Explicit assertions verify input values match expected
 * - Re-applies values if they reset due to re-render
 * - Waits for "Add Content" button to become enabled before clicking
 * - Verifies content appears in media list after modal closes
 * - Returns verified=true ONLY if hard evidence of attachment exists
 */
async function add3DContent(
  ctx: AutomationContext,
  tourUrl: string,
  baselineCount: number
): Promise<Add3DContentResult> {
  const log = logger.child({ run_id: ctx.runId, step: Steps.ADD_3D_CONTENT, tourUrl, baselineCount });

  // Check if this exact content already exists (idempotency)
  const alreadyExists = await has3DContentWithTitle(ctx.page, TEXT.IGUIDE_TITLE);
  if (alreadyExists) {
    log.info('3D Content with title "iGuide 3D Virtual Tour" already exists - skipping (idempotent)');
    await takeScreenshot(ctx, Steps.ADD_3D_CONTENT, 'already_exists');
    return { success: true, verified: true }; // Already exists = verified
  }

  // Report progress
  await reportProgress(ctx.runId, '3d_content', 0, 1, 'preflight_check');

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      log.info({ attempt }, 'Adding 3D Content');

      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 0: Open the 3D content modal
      // ═══════════════════════════════════════════════════════════════════════
      await reportProgress(ctx.runId, '3d_content', 0, 1, 'modal_open');

      const addButton = getAddButtonForRow(ctx.page, TEXT.THREE_D_CONTENT);
      await addButton.waitFor({ state: 'visible', timeout: TIMEOUTS.ELEMENT_VISIBLE });
      await addButton.click();
      log.debug('Clicked Add button for 3D Content');

      // Wait for modal to appear
      const modal = get3DContentModal(ctx.page);
      await modal.waitFor({ state: 'visible', timeout: 5000 });
      log.debug('3D Content modal appeared');

      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 1: Fill form with REQUIRED values
      // ═══════════════════════════════════════════════════════════════════════

      // Set and ASSERT Content Title = "iGuide 3D Virtual Tour"
      await setAndAssertTitle(ctx, TEXT.IGUIDE_TITLE, log);

      // Set and ASSERT Content Link
      await setAndAssertLink(ctx, tourUrl, log);

      // Set and ASSERT Display Type = "Both (Branded + Unbranded)"
      await setAndAssertDisplayType(ctx, log);

      // FINAL ASSERTION - Verify all values before clicking Add Content
      // This catches any re-renders that may have reset values
      const finalValidation = await validateFormValues(ctx, TEXT.IGUIDE_TITLE, tourUrl, log);
      if (!finalValidation.valid) {
        log.warn({ issues: finalValidation.issues }, 'Form values changed - re-applying...');
        if (!finalValidation.titleMatch) {
          await setAndAssertTitle(ctx, TEXT.IGUIDE_TITLE, log);
        }
        if (!finalValidation.linkMatch) {
          await setAndAssertLink(ctx, tourUrl, log);
        }
        if (!finalValidation.displayTypeMatch) {
          await setAndAssertDisplayType(ctx, log);
        }
      }

      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 2: Wait for Add Content button to be enabled and click it
      // ═══════════════════════════════════════════════════════════════════════
      await reportProgress(ctx.runId, '3d_content', 0, 1, 'add_enabled');

      const addContentButton = getAddContentButton(ctx.page);
      await addContentButton.waitFor({ state: 'visible', timeout: 5000 });

      // Wait for button to be enabled
      await ctx.page.waitForFunction(
        `(() => {
          const btn = document.querySelector('button[class*="bg-primary"]');
          if (!btn) return false;
          const text = btn.textContent || '';
          return text.includes('Add Content') && !btn.disabled;
        })()`,
        { timeout: TIMEOUTS.ADD_BUTTON_ENABLED }
      );

      await reportProgress(ctx.runId, '3d_content', 0, 1, 'add_clicked');
      log.info('Add Content button is enabled - clicking...');
      await addContentButton.click();

      // Wait for modal to close
      log.info('Waiting for 3D Content modal to close...');
      const modalClosed = await waitForModalClose(ctx.page, TIMEOUTS.MODAL_CLOSE);
      if (!modalClosed) {
        log.warn('Modal did not close within timeout - continuing to verification');
      } else {
        log.debug('3D Content modal closed');
      }

      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 3: Verify content was added (exponential backoff)
      // ═══════════════════════════════════════════════════════════════════════
      await reportProgress(ctx.runId, '3d_content', 0, 1, 'verify');
      log.info('Phase 3: Verifying 3D Content was added...');

      const verified = await verify3DContentWithBackoff(ctx, {
        expectedTitle: TEXT.IGUIDE_TITLE,
        baselineCount,
        timeout: TIMEOUTS.COUNT_VERIFICATION,
      });

      if (verified.success) {
        log.info({
          baselineCount,
          newCount: verified.newCount,
          method: verified.method,
        }, '3D Content VERIFIED');
        await takeScreenshot(ctx, Steps.ADD_3D_CONTENT, 'success');
        return { success: true, verified: true };
      }

      // Verification failed
      log.error({
        baselineCount,
        newCount: verified.newCount,
      }, '3D Content verification failed');

      // Check for error toast
      const errorToast = getErrorToast(ctx.page);
      if (await errorToast.isVisible()) {
        const errorText = await errorToast.textContent();
        log.error({ errorText }, 'Error toast visible after 3D content add');
        throw new Error(`Add 3D Content failed: ${errorText}`);
      }

      await takeScreenshot(ctx, Steps.ADD_3D_CONTENT, `verification_failed_${attempt}`);
      throw new Error(`Verification failed: 3D Content not visible (baseline: ${baselineCount}, current: ${verified.newCount})`);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn({ attempt, error: errorMessage }, `Add 3D Content attempt ${attempt}/${MAX_RETRIES} failed`);

      // Screenshot on failure
      await takeScreenshot(ctx, Steps.ADD_3D_CONTENT, `error_attempt_${attempt}`);

      // Close any open modal before retry
      await closeOpenModals(ctx);

      if (attempt < MAX_RETRIES) {
        log.info(`Retrying in ${RETRY_DELAY_MS}ms...`);
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  return {
    success: false,
    verified: false,
    error: {
      code: ErrorCodes.ACTION_FAILED,
      message: `Failed to add 3D Content after ${MAX_RETRIES} retries`,
      retryable: true,
    },
  };
}

/**
 * Verifies 3D content was added using title match or count increase, with exponential backoff.
 */
async function verify3DContentWithBackoff(
  ctx: AutomationContext,
  options: {
    expectedTitle: string;
    baselineCount: number;
    timeout: number;
  }
): Promise<{ success: boolean; newCount: number; method: string }> {
  const { expectedTitle, baselineCount, timeout } = options;
  const log = logger.child({ run_id: ctx.runId, expectedTitle, baselineCount });
  const startTime = Date.now();
  const backoffIntervals = TIMEOUTS.BACKOFF_INTERVALS;
  let backoffIndex = 0;

  while (Date.now() - startTime < timeout) {
    // Method 1: Check if title is visible (most reliable)
    const titleVisible = await has3DContentWithTitle(ctx.page, expectedTitle);
    if (titleVisible) {
      const currentCount = await getMediaRowCount(ctx.page, TEXT.THREE_D_CONTENT);
      return { success: true, newCount: currentCount, method: 'title_match' };
    }

    // Method 2: Check count increase
    const currentCount = await getMediaRowCount(ctx.page, TEXT.THREE_D_CONTENT);
    if (currentCount > baselineCount) {
      return { success: true, newCount: currentCount, method: 'count_increase' };
    }

    // Wait with exponential backoff
    const waitTime = backoffIntervals[Math.min(backoffIndex, backoffIntervals.length - 1)] ?? 5000;
    log.debug({ currentCount, waitTime }, '3D Content not yet visible, waiting...');
    await delay(waitTime);
    backoffIndex++;
  }

  // Final check
  const titleVisible = await has3DContentWithTitle(ctx.page, expectedTitle);
  const finalCount = await getMediaRowCount(ctx.page, TEXT.THREE_D_CONTENT);

  if (titleVisible || finalCount > baselineCount) {
    return { success: true, newCount: finalCount, method: titleVisible ? 'title_match' : 'count_increase' };
  }

  return { success: false, newCount: finalCount, method: 'none' };
}

/**
 * Sets the Content Title input and asserts it matches expected value
 */
async function setAndAssertTitle(
  ctx: AutomationContext,
  expectedTitle: string,
  log: typeof logger
): Promise<void> {
  const titleInput = getContentTitleInput(ctx.page);
  await titleInput.waitFor({ state: 'visible', timeout: 5000 });
  await titleInput.clear();
  await titleInput.fill(expectedTitle);

  // ASSERTION: Verify the value was set correctly
  const actualValue = await titleInput.inputValue();
  if (actualValue !== expectedTitle) {
    log.warn({ expected: expectedTitle, actual: actualValue }, 'Title value mismatch - retrying fill');
    await titleInput.clear();
    await titleInput.type(expectedTitle, { delay: 50 }); // Slower typing as fallback

    const retryValue = await titleInput.inputValue();
    if (retryValue !== expectedTitle) {
      throw new Error(`Failed to set Content Title: expected "${expectedTitle}", got "${retryValue}"`);
    }
  }

  log.info({ title: expectedTitle }, 'Content Title set and verified');
}

/**
 * Sets the Content Link input and asserts it matches expected value
 */
async function setAndAssertLink(
  ctx: AutomationContext,
  expectedUrl: string,
  log: typeof logger
): Promise<void> {
  const linkInput = getContentLinkInput(ctx.page);
  await linkInput.waitFor({ state: 'visible', timeout: 5000 });
  await linkInput.clear();
  await linkInput.fill(expectedUrl);

  // ASSERTION: Verify the value was set correctly
  const actualValue = await linkInput.inputValue();
  if (actualValue !== expectedUrl) {
    log.warn({ expected: expectedUrl, actual: actualValue }, 'Link value mismatch - retrying fill');
    await linkInput.clear();
    await linkInput.type(expectedUrl, { delay: 20 });

    const retryValue = await linkInput.inputValue();
    if (retryValue !== expectedUrl) {
      throw new Error(`Failed to set Content Link: expected "${expectedUrl}", got "${retryValue}"`);
    }
  }

  log.info('Content Link set and verified');
}

/**
 * Sets the Display Type dropdown and asserts it's set to "Both"
 */
async function setAndAssertDisplayType(
  ctx: AutomationContext,
  log: typeof logger
): Promise<void> {
  const displayDropdown = getDisplayTypeDropdown(ctx.page);

  try {
    await displayDropdown.waitFor({ state: 'visible', timeout: 3000 });

    // Try to select "both" value
    try {
      await displayDropdown.selectOption({ value: 'both' });
    } catch {
      try {
        await displayDropdown.selectOption({ label: TEXT.DISPLAY_BOTH });
      } catch {
        // Try clicking the dropdown and selecting manually
        await displayDropdown.click();
        await ctx.page.waitForTimeout(200);
        const option = ctx.page.locator('option').filter({ hasText: /both/i });
        if (await option.isVisible()) {
          await option.click();
        }
      }
    }

    // ASSERTION: Verify the value was set correctly
    const selectedValue = await displayDropdown.inputValue();
    if (!selectedValue.toLowerCase().includes('both')) {
      log.warn({ selected: selectedValue }, 'Display Type not set to "both" - attempting alternative');

      // Try evaluating directly
      await ctx.page.evaluate(`(() => {
        const select = document.querySelector('select[id*="DisplayType"]');
        if (select) {
          const options = Array.from(select.options);
          const bothOption = options.find(opt =>
            opt.value.toLowerCase() === 'both' || opt.text.toLowerCase().includes('both')
          );
          if (bothOption) {
            select.value = bothOption.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      })()`);

      const finalValue = await displayDropdown.inputValue();
      log.info({ displayType: finalValue }, 'Display Type set');
    } else {
      log.info('Display Type set to "Both" and verified');
    }

  } catch (err) {
    log.warn({ error: err instanceof Error ? err.message : String(err) },
      'Could not set Display Type - proceeding with default');
  }
}

/**
 * Validates all form values before clicking Add Content
 */
async function validateFormValues(
  ctx: AutomationContext,
  expectedTitle: string,
  expectedUrl: string,
  log: typeof logger
): Promise<{ valid: boolean; titleMatch: boolean; linkMatch: boolean; displayTypeMatch: boolean; issues: string[] }> {
  const issues: string[] = [];
  let titleMatch = true;
  let linkMatch = true;
  let displayTypeMatch = true;

  try {
    const titleInput = getContentTitleInput(ctx.page);
    const actualTitle = await titleInput.inputValue();
    titleMatch = actualTitle === expectedTitle;
    if (!titleMatch) {
      issues.push(`Title mismatch: expected "${expectedTitle}", got "${actualTitle}"`);
    }
  } catch {
    issues.push('Could not read title value');
    titleMatch = false;
  }

  try {
    const linkInput = getContentLinkInput(ctx.page);
    const actualLink = await linkInput.inputValue();
    linkMatch = actualLink === expectedUrl;
    if (!linkMatch) {
      issues.push(`Link mismatch: expected "${expectedUrl}", got "${actualLink}"`);
    }
  } catch {
    issues.push('Could not read link value');
    linkMatch = false;
  }

  try {
    const displayDropdown = getDisplayTypeDropdown(ctx.page);
    const selectedValue = await displayDropdown.inputValue();
    displayTypeMatch = selectedValue.toLowerCase().includes('both');
    if (!displayTypeMatch) {
      issues.push(`Display type not set to "both": got "${selectedValue}"`);
    }
  } catch {
    // Display type is optional
    displayTypeMatch = true;
  }

  const valid = titleMatch && linkMatch && displayTypeMatch;
  if (!valid) {
    log.debug({ issues }, 'Form validation issues detected');
  }

  return { valid, titleMatch, linkMatch, displayTypeMatch, issues };
}

/**
 * Saves the listing changes
 *
 * STATE-DRIVEN: Waits for save operation to complete based on UI state,
 * not fixed delays.
 */
async function saveListing(
  ctx: AutomationContext
): Promise<{ success: true } | { success: false; error: DeliveryError }> {
  const log = logger.child({ run_id: ctx.runId, step: Steps.SAVE_LISTING });

  await reportProgress(ctx.runId, 'save', 0, 1, 'modal_open');

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      log.info({ attempt }, 'Saving listing');

      const saveButton = getSaveButton(ctx.page);
      await saveButton.waitFor({ state: 'visible', timeout: TIMEOUTS.ELEMENT_VISIBLE });

      // Check if button is enabled before clicking
      const isDisabled = await saveButton.isDisabled();
      if (isDisabled) {
        log.debug('Save button is disabled - waiting for it to become enabled');
        await ctx.page.waitForFunction(
          `(() => {
            const btn = document.querySelector('button[type="submit"]');
            return btn && !btn.disabled;
          })()`,
          { timeout: 5000 }
        ).catch(() => {
          log.debug('Save button remained disabled - clicking anyway');
        });
      }

      await saveButton.click();
      log.debug('Clicked Save button');

      // STATE-DRIVEN: Wait for loading to complete
      await waitForLoadingComplete(ctx.page, TIMEOUTS.MODAL_CLOSE);

      // Poll for success or error state
      const saveResult = await waitForSaveResult(ctx.page, 10000);

      if (saveResult.error) {
        throw new Error(`Save failed: ${saveResult.errorMessage}`);
      }

      if (saveResult.success) {
        log.debug('Success toast appeared');
      }

      // Final check for error toast
      const errorToast = getErrorToast(ctx.page);
      if (await errorToast.isVisible()) {
        const errorText = await errorToast.textContent();
        throw new Error(`Save failed: ${errorText}`);
      }

      await takeScreenshot(ctx, Steps.SAVE_LISTING, 'success');
      log.info('Listing saved successfully');
      return { success: true };
    } catch (err) {
      log.warn({ attempt, error: err instanceof Error ? err.message : String(err) }, 'Save attempt failed');

      await takeScreenshot(ctx, Steps.SAVE_LISTING, `error_attempt_${attempt}`);

      if (attempt < MAX_RETRIES) {
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  return {
    success: false,
    error: {
      code: ErrorCodes.ARYEO_SAVE_FAILED,
      message: 'Failed to save listing after retries',
      retryable: true,
    },
  };
}

/**
 * Waits for save operation to complete by polling for success or error toasts
 */
async function waitForSaveResult(
  page: Page,
  timeout: number
): Promise<{ success: boolean; error: boolean; errorMessage: string | null }> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    // Check for success toast
    const successToast = getSuccessToast(page);
    if (await successToast.isVisible().catch(() => false)) {
      return { success: true, error: false, errorMessage: null };
    }

    // Check for error toast
    const errorToast = getErrorToast(page);
    if (await errorToast.isVisible().catch(() => false)) {
      const errorText = await errorToast.textContent().catch(() => null);
      return { success: false, error: true, errorMessage: errorText };
    }

    await page.waitForTimeout(TIMEOUTS.STATE_POLL_INTERVAL);
  }

  // No definitive result - assume success if no error
  return { success: false, error: false, errorMessage: null };
}

/**
 * Delivers the listing / sends to client
 *
 * STATE-DRIVEN: Waits for delivery modal and result based on UI state.
 */
async function deliverListing(
  ctx: AutomationContext
): Promise<{ success: true } | { success: false; error: DeliveryError }> {
  const log = logger.child({ run_id: ctx.runId, step: Steps.DELIVER_LISTING });

  await reportProgress(ctx.runId, 'deliver', 0, 1, 'modal_open');

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      log.info({ attempt }, 'Delivering listing');

      // STEP 1: Click the "Deliver Listing" or "Re-deliver Listing" button
      const deliverButton = getDeliverButton(ctx.page);
      await deliverButton.waitFor({ state: 'visible', timeout: TIMEOUTS.ELEMENT_VISIBLE });
      await deliverButton.click();
      log.debug('Clicked Deliver Listing button');

      // STEP 2: Wait for the delivery modal to appear
      const modal = getDeliverConfirmModal(ctx.page);
      await modal.waitFor({ state: 'visible', timeout: 5000 });
      log.debug('Delivery modal appeared');

      // STEP 3: Wait for confirm button to be visible and click it
      const confirmButton = getDeliverConfirmButton(ctx.page);
      await confirmButton.waitFor({ state: 'visible', timeout: 5000 });

      // Ensure button is clickable (not disabled)
      const isDisabled = await confirmButton.isDisabled().catch(() => false);
      if (isDisabled) {
        log.debug('Confirm button is disabled - waiting for it to become enabled');
        await ctx.page.waitForFunction(
          `(() => {
            const btns = document.querySelectorAll('button[class*="bg-primary"]');
            for (const btn of btns) {
              if (btn.textContent && btn.textContent.includes('Deliver') && !btn.disabled) {
                return true;
              }
            }
            return false;
          })()`,
          { timeout: 5000 }
        );
      }

      await reportProgress(ctx.runId, 'deliver', 0, 1, 'add_clicked');
      log.info('Clicking Deliver confirm button');
      await confirmButton.click();

      // STEP 4: STATE-DRIVEN wait for delivery to complete
      await waitForLoadingComplete(ctx.page, TIMEOUTS.MODAL_CLOSE);

      // Poll for success or error state
      await reportProgress(ctx.runId, 'deliver', 0, 1, 'verify');
      const deliverResult = await waitForSaveResult(ctx.page, 15000);

      if (deliverResult.error) {
        throw new Error(`Delivery failed: ${deliverResult.errorMessage}`);
      }

      if (deliverResult.success) {
        log.debug('Delivery success toast appeared');
      }

      // Wait for modal to close
      const modalClosed = await waitForModalClose(ctx.page, TIMEOUTS.MODAL_CLOSE);
      if (!modalClosed) {
        log.debug('Modal did not close - checking success anyway');
      }

      // Final check for error toast
      const errorToast = getErrorToast(ctx.page);
      if (await errorToast.isVisible()) {
        const errorText = await errorToast.textContent();
        throw new Error(`Delivery failed: ${errorText}`);
      }

      await takeScreenshot(ctx, Steps.DELIVERY_CONFIRMED, 'success');
      log.info('Listing delivered successfully');
      return { success: true };
    } catch (err) {
      log.warn({ attempt, error: err instanceof Error ? err.message : String(err) }, 'Deliver attempt failed');

      await takeScreenshot(ctx, Steps.DELIVER_LISTING, `error_attempt_${attempt}`);

      // Close any open modal before retry
      try {
        await ctx.page.keyboard.press('Escape');
        await ctx.page.waitForTimeout(300);
      } catch {
        // Ignore
      }

      // Determine if error is retryable
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isTransient =
        errorMessage.includes('timeout') ||
        errorMessage.includes('Timeout') ||
        errorMessage.includes('navigation') ||
        errorMessage.includes('net::');

      if (attempt < MAX_RETRIES) {
        await delay(RETRY_DELAY_MS);
      } else {
        return {
          success: false,
          error: {
            code: ErrorCodes.ARYEO_DELIVER_FAILED,
            message: `Failed to deliver listing after retries: ${errorMessage}`,
            retryable: isTransient,
          },
        };
      }
    }
  }

  return {
    success: false,
    error: {
      code: ErrorCodes.ARYEO_DELIVER_FAILED,
      message: 'Failed to deliver listing after retries',
      retryable: true,
    },
  };
}

/**
 * Main automation function that orchestrates the entire delivery flow
 */
export async function runDeliveryAutomation(
  runId: string,
  manifest: InternalManifest,
  evidenceDir: string,
  options: AutomationOptions = { deliverAfterAttach: false }
): Promise<AutomationOutcome> {
  const log = logger.child({ run_id: runId, deliverAfterAttach: options.deliverAfterAttach });
  log.info({
    floorplanUrls: manifest.sources.floorplan_urls,
    rmsUrls: manifest.sources.rms_urls,
    tourUrl: manifest.sources.tour_3d_url,
    listingUrl: manifest.aryeo.listing_edit_url,
  }, 'Starting Aryeo delivery automation');

  // Track actions performed
  const actions: ActionsPerformed = {
    imported_floorplans: false,
    imported_rms: false,
    added_3d_content: false,
    saved: false,
    delivered: false,
  };

  // Ensure evidence directory exists
  await fsp.mkdir(evidenceDir, { recursive: true });

  // Create authenticated browser context
  const authContext = await createAuthenticatedContext();
  if (!authContext) {
    return {
      success: false,
      error: {
        code: ErrorCodes.ARYEO_LOGIN_REQUIRED,
        message: 'Could not create authenticated browser context. Run the login script.',
        retryable: false,
      },
      actions,
    };
  }

  const { browser, context } = authContext;
  const page = await context.newPage();

  const ctx: AutomationContext = {
    browser,
    context,
    page,
    runId,
    evidenceDir,
  };

  try {
    // Step 1: Navigate to listing
    const navResult = await navigateToListing(ctx, manifest.aryeo.listing_edit_url);
    if (!navResult.success) {
      return { success: false, error: navResult.error, actions };
    }

    // Step 2: Capture baseline counts BEFORE any imports
    const baselineCounts = await captureBaselineCounts(ctx);
    log.info({ baselineCounts }, 'Captured baseline counts');

    // Step 3: Import floor plans with verification (includes pre-dedup)
    const floorplanResult = await importFloorplans(ctx, manifest.sources.floorplan_urls);
    if (!floorplanResult.success) {
      return { success: false, error: floorplanResult.error!, actions };
    }
    // CRITICAL: Only set flag to true if ALL items were verified attached
    actions.imported_floorplans = floorplanResult.allVerified && floorplanResult.totalCount > 0;
    if (floorplanResult.totalCount > 0 && !floorplanResult.allVerified) {
      log.warn({
        successCount: floorplanResult.successCount,
        skippedCount: floorplanResult.skippedCount,
        totalCount: floorplanResult.totalCount,
      }, 'Floor plans: not all items verified - imported_floorplans set to false');
    }

    // Step 4: Import RMS files with verification (includes pre-dedup)
    const rmsResult = await importRmsFiles(ctx, manifest.sources.rms_urls);
    if (!rmsResult.success) {
      return { success: false, error: rmsResult.error!, actions };
    }
    // CRITICAL: Only set flag to true if ALL items were verified attached
    actions.imported_rms = rmsResult.allVerified && rmsResult.totalCount > 0;
    if (rmsResult.totalCount > 0 && !rmsResult.allVerified) {
      log.warn({
        successCount: rmsResult.successCount,
        skippedCount: rmsResult.skippedCount,
        totalCount: rmsResult.totalCount,
      }, 'RMS files: not all items verified - imported_rms set to false');
    }

    // Step 5: Add 3D Content (iGuide tour) with verification
    const content3dResult = await add3DContent(
      ctx,
      manifest.sources.tour_3d_url,
      baselineCounts.threeDContent
    );
    if (!content3dResult.success) {
      return {
        success: false,
        error: content3dResult.error ?? {
          code: ErrorCodes.ACTION_FAILED,
          message: 'Failed to add 3D Content',
          retryable: true,
        },
        actions,
      };
    }
    // CRITICAL: Only set flag to true if verified
    actions.added_3d_content = content3dResult.verified;

    // Step 6: Save the listing
    const saveResult = await saveListing(ctx);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error, actions };
    }
    actions.saved = true;

    // Step 7: Conditionally deliver to client
    if (options.deliverAfterAttach) {
      log.info('Delivering listing (deliver_after_attach=true)');
      const deliverResult = await deliverListing(ctx);
      if (!deliverResult.success) {
        return { success: false, error: deliverResult.error, actions };
      }
      actions.delivered = true;
      log.info('Aryeo delivery automation completed successfully with delivery');
    } else {
      log.info('Skipping delivery step (deliver_after_attach=false)');
      await takeScreenshot(ctx, Steps.DELIVERY_SKIPPED, 'skipped');
      log.info('Aryeo delivery automation completed successfully without delivery');
    }

    return { success: true, actions };
  } catch (err) {
    log.error({ error: err instanceof Error ? err.message : String(err) }, 'Unexpected error during automation');

    await takeScreenshot(ctx, Steps.ERROR, 'unexpected');

    return {
      success: false,
      error: {
        code: ErrorCodes.INTERNAL_ERROR,
        message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
      },
      actions,
    };
  } finally {
    // Always close browser
    try {
      await page.close();
      await context.close();
      await browser.close();
      log.debug('Browser closed');
    } catch {
      // Ignore cleanup errors
    }
  }
}
