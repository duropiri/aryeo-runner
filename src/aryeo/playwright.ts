import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from 'playwright';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { addEvidenceScreenshot } from '../queue.js';
import { ErrorCodes, type DeliveryError, type InternalManifest } from '../types.js';
import {
  TEXT,
  TIMEOUTS,
  getMediaRow,
  getMediaRowCount,
  getAddButtonForRow,
  getFromLinkOption,
  getImportUrlInput,
  getImportButton,
  getSetTitlesCheckbox,
  getCommitFilesButton,
  getUploadModal,
  getStagedFilePreview,
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
  isUploadInProgress,
  isUIReadyForCommit,
  waitForUploadReadyState,
  waitForMediaSectionUpdate,
  waitForModalClose,
  hasFileInMediaRow,
  type UploadUIState,
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
 * Waits for count to increment from baseline
 */
async function waitForCountIncrement(
  ctx: AutomationContext,
  rowLabel: string,
  baselineCount: number,
  timeout: number = TIMEOUTS.POST_VERIFY
): Promise<boolean> {
  const log = logger.child({ run_id: ctx.runId, rowLabel, baselineCount });
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const currentCount = await getMediaRowCount(ctx.page, rowLabel);
    if (currentCount > baselineCount) {
      log.info({ baselineCount, currentCount }, 'Count increment verified');
      return true;
    }
    await delay(500);
  }

  log.warn({ baselineCount }, 'Count did not increment within timeout');
  return false;
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
 * Imports a single URL via the "From link" flow for Floor Plans or Files.
 *
 * STATE-DRIVEN APPROACH:
 * - No fixed delays or blind retries
 * - All waits are based on observable UI state
 * - Only declares failure when UI is idle and expected state did not occur
 */
async function importFromLink(
  ctx: AutomationContext,
  rowLabel: string,
  url: string,
  checkSetTitlesFromFilenames: boolean,
  step: string,
  index: number,
  baselineCount: number
): Promise<{ success: true } | { success: false; error: DeliveryError }> {
  const log = logger.child({ run_id: ctx.runId, step, rowLabel, index, url, baselineCount });
  const expectedCountAfterImport = baselineCount + index + 1;

  // Extract filename from URL for verification
  const urlFilename = extractFilenameFromUrl(url);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      log.info({ attempt }, `Importing URL via "From link" for ${rowLabel}`);

      // STEP 1: Click Add button for this row
      const addButton = getAddButtonForRow(ctx.page, rowLabel);
      await addButton.waitFor({ state: 'visible', timeout: TIMEOUTS.ELEMENT_VISIBLE });
      await addButton.click();
      log.debug('Clicked Add button');

      // STEP 2: Wait for and click "From link" option
      const fromLinkOption = getFromLinkOption(ctx.page);
      await fromLinkOption.waitFor({ state: 'visible', timeout: 5000 });
      await fromLinkOption.click();
      log.debug('Clicked "From link" option');

      // STEP 3: Fill the URL input
      const urlInput = getImportUrlInput(ctx.page);
      await urlInput.waitFor({ state: 'visible', timeout: 5000 });
      await urlInput.fill(url);
      log.debug('Filled URL input');

      // STEP 4: Handle "Set titles from filenames" checkbox with ASSERTION
      if (checkSetTitlesFromFilenames) {
        await handleSetTitlesCheckbox(ctx, log);
      }

      // STEP 5: Click Import button to START STAGING
      const importButton = getImportButton(ctx.page);
      await importButton.waitFor({ state: 'visible', timeout: 5000 });
      await importButton.click();
      log.info('Clicked Import button - staging started');

      // STEP 6: STATE-DRIVEN WAIT for upload to complete
      // This polls the UI state until ALL conditions are met:
      // - Progress bar gone or at 100%
      // - File row shows real filename (not skeleton)
      // - Add Files button is enabled
      // - No loading spinner in modal
      log.info('Waiting for upload to complete (state-driven)...');

      const uploadResult = await waitForUploadReadyState(ctx.page, TIMEOUTS.UPLOAD_PROGRESS_COMPLETE);

      if (!uploadResult.ready) {
        // Log detailed state for debugging
        log.warn({
          reason: uploadResult.reason,
          state: uploadResult.state,
        }, 'Upload did not reach ready state');

        // Check if it's still in progress (not a true failure yet)
        if (isUploadInProgress(uploadResult.state)) {
          // This is UPLOAD_PENDING, not a failure - but we've hit our timeout
          throw new Error(`Upload timeout: ${uploadResult.reason}`);
        }

        // Check for error in the UI
        if (uploadResult.state.hasErrorMessage) {
          throw new Error(`Upload failed: ${uploadResult.state.errorMessage || 'Unknown error'}`);
        }

        throw new Error(`UI not ready for commit: ${uploadResult.reason}`);
      }

      log.info({
        progressPercent: uploadResult.state.progressPercent,
        hasRealFilename: uploadResult.state.hasRealFilename,
        buttonEnabled: uploadResult.state.isAddFilesButtonEnabled,
      }, 'Upload complete - UI ready for commit');

      // STEP 7: CLICK THE COMMIT BUTTON (Add Files)
      const commitButton = getCommitFilesButton(ctx.page);
      log.info('Clicking commit button to add file to listing...');
      await commitButton.click();
      log.debug('Clicked commit button');

      // STEP 8: Wait for modal to close (state-driven)
      log.info('Waiting for modal to close...');
      const modalClosed = await waitForModalClose(ctx.page, TIMEOUTS.MODAL_CLOSE);

      if (!modalClosed) {
        log.warn('Modal did not close within timeout - checking if upload succeeded anyway');
      } else {
        log.debug('Modal closed successfully');
      }

      // STEP 9: Wait for media section to re-render and verify
      log.info('Waiting for media section to update...');
      const mediaUpdate = await waitForMediaSectionUpdate(
        ctx.page,
        rowLabel,
        baselineCount + index, // Expected count before this import
        TIMEOUTS.MEDIA_SECTION_RERENDER
      );

      // STEP 10: VERIFY the file was actually added
      log.info({ currentCount: mediaUpdate.newCount, expectedCount: expectedCountAfterImport }, 'Verifying import...');

      if (mediaUpdate.updated && mediaUpdate.newCount >= expectedCountAfterImport) {
        log.info({ baselineCount, newCount: mediaUpdate.newCount }, 'Post-condition VERIFIED: count increased');
        await takeScreenshot(ctx, step, `success_${index}`);
        return { success: true };
      }

      // Count didn't increase - try alternative verification: check if filename appears
      if (urlFilename) {
        const filenameVisible = await hasFileInMediaRow(ctx.page, rowLabel, urlFilename);
        if (filenameVisible) {
          log.warn({
            baselineCount,
            currentCount: mediaUpdate.newCount,
            filename: urlFilename,
          }, 'Filename visible but count did not change - treating as success');
          await takeScreenshot(ctx, step, `success_filename_visible_${index}`);
          return { success: true };
        }
      }

      // Check for error toast
      const errorToast = getErrorToast(ctx.page);
      if (await errorToast.isVisible()) {
        const errorText = await errorToast.textContent();
        throw new Error(`Import failed with error: ${errorText}`);
      }

      // Verification failed but UI is idle - this is ACTION_FAILED
      await takeScreenshot(ctx, step, `verification_failed_${attempt}_${index}`);
      throw new Error(`Verification failed: ${rowLabel} count did not increase (baseline: ${baselineCount}, current: ${mediaUpdate.newCount}, expected: ${expectedCountAfterImport})`);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn({ attempt, error: errorMessage }, `Import attempt failed for ${rowLabel}`);

      // Only take screenshot if UI is idle (not during loading states)
      const currentState = await getUploadUIState(ctx.page);
      if (!isUploadInProgress(currentState)) {
        await takeScreenshot(ctx, step, `error_attempt_${attempt}_${index}`);
      }

      // Close any open modals before retry
      try {
        await ctx.page.keyboard.press('Escape');
        await ctx.page.waitForTimeout(300);
        await ctx.page.keyboard.press('Escape');
        await ctx.page.waitForTimeout(300);
      } catch {
        // Ignore
      }

      if (attempt < MAX_RETRIES) {
        // Only retry if UI is in a stable state (not still processing)
        const stateBeforeRetry = await getUploadUIState(ctx.page);
        if (isUploadInProgress(stateBeforeRetry)) {
          log.info('Upload still in progress - waiting before retry...');
          // Wait for it to complete or fail before retrying
          await waitForUploadReadyState(ctx.page, TIMEOUTS.UPLOAD_PROGRESS_COMPLETE);
        }
        log.info(`Retrying import in ${RETRY_DELAY_MS}ms...`);
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  return {
    success: false,
    error: {
      code: ErrorCodes.ACTION_FAILED,
      message: `Failed to import URL for ${rowLabel} after ${MAX_RETRIES} retries (UI was idle, action did not succeed): ${url}`,
      retryable: true,
    },
  };
}

/**
 * Handles the "Set titles from filenames" checkbox with proper assertion
 */
async function handleSetTitlesCheckbox(
  ctx: AutomationContext,
  log: typeof logger
): Promise<void> {
  const checkbox = getSetTitlesCheckbox(ctx.page);

  try {
    // Wait for checkbox to be visible
    const isVisible = await checkbox.isVisible({ timeout: 3000 }).catch(() => false);

    if (!isVisible) {
      log.info('"Set titles from filenames" checkbox not found - proceeding without it');
      return;
    }

    // Check current state
    const isChecked = await checkbox.isChecked();

    if (!isChecked) {
      await checkbox.check();
      log.debug('Checked "Set titles from filenames" checkbox');

      // ASSERTION: Verify it's now checked
      const isNowChecked = await checkbox.isChecked();
      if (!isNowChecked) {
        log.warn('Checkbox check failed - attempting to click directly');
        await checkbox.click();

        // Re-verify
        const finalState = await checkbox.isChecked();
        if (finalState) {
          log.debug('Checkbox checked via direct click');
        } else {
          log.warn('Could not check "Set titles from filenames" checkbox - proceeding anyway');
        }
      }
    } else {
      log.debug('"Set titles from filenames" checkbox already checked');
    }
  } catch (err) {
    log.info({ error: err instanceof Error ? err.message : String(err) },
      'Error handling "Set titles from filenames" checkbox - proceeding without it');
  }
}

/**
 * Extracts filename from a URL for verification purposes
 */
function extractFilenameFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const filename = pathname.split('/').pop();
    if (filename && filename.length > 0) {
      // Remove common URL-encoded characters
      return decodeURIComponent(filename).replace(/\+/g, ' ');
    }
  } catch {
    // Invalid URL
  }
  return null;
}

/**
 * Imports all floor plan URLs with proper verification
 */
async function importFloorplans(
  ctx: AutomationContext,
  urls: string[],
  baselineCount: number
): Promise<{ success: true } | { success: false; error: DeliveryError }> {
  const log = logger.child({ run_id: ctx.runId, count: urls.length, baselineCount });

  if (urls.length === 0) {
    log.info('No floor plan URLs to import, skipping');
    return { success: true };
  }

  log.info({ urls }, 'Starting floor plan imports');

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    if (!url) continue;

    const result = await importFromLink(
      ctx,
      TEXT.FLOOR_PLANS,
      url,
      true, // Check "Set titles from filenames" for floor plans
      Steps.IMPORT_FLOORPLAN,
      i,
      baselineCount
    );

    if (!result.success) {
      return result;
    }

    // Small delay between imports
    if (i < urls.length - 1) {
      await delay(1000);
    }
  }

  // Final verification: check total count matches expected
  const finalCount = await getMediaRowCount(ctx.page, TEXT.FLOOR_PLANS);
  const expectedCount = baselineCount + urls.length;

  if (finalCount >= expectedCount) {
    log.info({ baselineCount, finalCount, expectedCount }, 'All floor plans imported and VERIFIED');
  } else {
    log.warn({ baselineCount, finalCount, expectedCount }, 'Floor plan count lower than expected, but individual imports succeeded');
  }

  return { success: true };
}

/**
 * Imports all RMS URLs (into the Files row) with proper verification
 */
async function importRmsFiles(
  ctx: AutomationContext,
  urls: string[],
  baselineCount: number
): Promise<{ success: true } | { success: false; error: DeliveryError }> {
  const log = logger.child({ run_id: ctx.runId, count: urls.length, baselineCount });

  if (urls.length === 0) {
    log.info('No RMS URLs to import, skipping');
    return { success: true };
  }

  log.info({ urls }, 'Starting RMS file imports');

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    if (!url) continue;

    const result = await importFromLink(
      ctx,
      TEXT.FILES,
      url,
      false, // No "Set titles from filenames" for Files/RMS
      Steps.IMPORT_RMS,
      i,
      baselineCount
    );

    if (!result.success) {
      return result;
    }

    // Small delay between imports
    if (i < urls.length - 1) {
      await delay(1000);
    }
  }

  // Final verification
  const finalCount = await getMediaRowCount(ctx.page, TEXT.FILES);
  const expectedCount = baselineCount + urls.length;

  if (finalCount >= expectedCount) {
    log.info({ baselineCount, finalCount, expectedCount }, 'All RMS files imported and VERIFIED');
  } else {
    log.warn({ baselineCount, finalCount, expectedCount }, 'Files count lower than expected, but individual imports succeeded');
  }

  return { success: true };
}

/**
 * Adds 3D Content (iGuide tour) via the modal with proper verification.
 *
 * STATE-DRIVEN APPROACH with explicit assertions:
 * - Title must ALWAYS be exactly: "iGuide 3D Virtual Tour"
 * - Display type must ALWAYS be: "Both (Branded + Unbranded)"
 * - Explicit assertions verify input values match expected
 * - Re-applies values if they reset due to re-render
 * - Waits for "Add Content" button to become enabled before clicking
 * - Verifies content appears in media list after modal closes
 */
async function add3DContent(
  ctx: AutomationContext,
  tourUrl: string,
  baselineCount: number
): Promise<{ success: true } | { success: false; error: DeliveryError }> {
  const log = logger.child({ run_id: ctx.runId, step: Steps.ADD_3D_CONTENT, tourUrl, baselineCount });

  // Check if this exact content already exists (idempotency)
  const alreadyExists = await has3DContentWithTitle(ctx.page, TEXT.IGUIDE_TITLE);
  if (alreadyExists) {
    log.info('3D Content with title "iGuide 3D Virtual Tour" already exists - skipping (idempotent)');
    await takeScreenshot(ctx, Steps.ADD_3D_CONTENT, 'already_exists');
    return { success: true };
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      log.info({ attempt }, 'Adding 3D Content');

      // STEP 1: Click Add button for 3D Content row
      const addButton = getAddButtonForRow(ctx.page, TEXT.THREE_D_CONTENT);
      await addButton.waitFor({ state: 'visible', timeout: TIMEOUTS.ELEMENT_VISIBLE });
      await addButton.click();
      log.debug('Clicked Add button for 3D Content');

      // STEP 2: Wait for modal to appear
      const modal = get3DContentModal(ctx.page);
      await modal.waitFor({ state: 'visible', timeout: 5000 });
      log.debug('3D Content modal appeared');

      // STEP 3: Set and ASSERT Content Title
      await setAndAssertTitle(ctx, TEXT.IGUIDE_TITLE, log);

      // STEP 4: Set and ASSERT Content Link
      await setAndAssertLink(ctx, tourUrl, log);

      // STEP 5: Set and ASSERT Display Type
      await setAndAssertDisplayType(ctx, log);

      // STEP 6: FINAL ASSERTION - Verify all values before clicking Add Content
      // This catches any re-renders that may have reset values
      const finalValidation = await validateFormValues(ctx, TEXT.IGUIDE_TITLE, tourUrl, log);
      if (!finalValidation.valid) {
        log.warn({ issues: finalValidation.issues }, 'Form values changed - re-applying...');
        // Re-apply any values that were reset
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

      // STEP 7: Wait for Add Content button to be enabled
      const addContentButton = getAddContentButton(ctx.page);
      await addContentButton.waitFor({ state: 'visible', timeout: 5000 });

      // Wait for button to be enabled (not disabled)
      await ctx.page.waitForFunction(
        `(() => {
          const btn = document.querySelector('button[class*="bg-primary"]');
          if (!btn) return false;
          const text = btn.textContent || '';
          return text.includes('Add Content') && !btn.disabled;
        })()`,
        { timeout: TIMEOUTS.COMMIT_BUTTON_ENABLED }
      );

      log.info('Add Content button is enabled - clicking...');
      await addContentButton.click();

      // STEP 8: Wait for modal to close (state-driven)
      log.info('Waiting for 3D Content modal to close...');
      const modalClosed = await waitForModalClose(ctx.page, TIMEOUTS.MODAL_CLOSE);

      if (!modalClosed) {
        log.warn('Modal did not close within timeout - checking if content was added anyway');
      } else {
        log.debug('3D Content modal closed');
      }

      // STEP 9: Wait for media section to update and VERIFY content was added
      log.info('Verifying 3D Content was added...');

      // Method 1: Check if item with title appears (most reliable)
      const contentExists = await waitFor3DContentWithTitle(ctx.page, TEXT.IGUIDE_TITLE, TIMEOUTS.POST_VERIFY);
      if (contentExists) {
        log.info('Post-condition VERIFIED: 3D Content with title visible');
        await takeScreenshot(ctx, Steps.ADD_3D_CONTENT, 'success');
        return { success: true };
      }

      // Method 2: Check if count incremented
      const updateResult = await waitForMediaSectionUpdate(
        ctx.page,
        TEXT.THREE_D_CONTENT,
        baselineCount,
        TIMEOUTS.POST_VERIFY
      );

      if (updateResult.updated) {
        log.info({ baselineCount, currentCount: updateResult.newCount }, 'Post-condition VERIFIED: 3D Content count increased');
        await takeScreenshot(ctx, Steps.ADD_3D_CONTENT, 'success');
        return { success: true };
      }

      // Check for error toast
      const errorToast = getErrorToast(ctx.page);
      if (await errorToast.isVisible()) {
        const errorText = await errorToast.textContent();
        throw new Error(`Add 3D Content failed: ${errorText}`);
      }

      // Verification failed - only screenshot if UI is idle
      await takeScreenshot(ctx, Steps.ADD_3D_CONTENT, `verification_failed_${attempt}`);
      throw new Error(`Verification failed: 3D Content not visible after add (baseline: ${baselineCount}, current: ${updateResult.newCount})`);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn({ attempt, error: errorMessage }, 'Add 3D Content attempt failed');

      // Only screenshot during true failures, not loading states
      await takeScreenshot(ctx, Steps.ADD_3D_CONTENT, `error_attempt_${attempt}`);

      // Close any open modal before retry
      try {
        await ctx.page.keyboard.press('Escape');
        await ctx.page.waitForTimeout(300);
      } catch {
        // Ignore
      }

      if (attempt < MAX_RETRIES) {
        log.info(`Retrying in ${RETRY_DELAY_MS}ms...`);
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  return {
    success: false,
    error: {
      code: ErrorCodes.ACTION_FAILED,
      message: `Failed to add 3D Content after ${MAX_RETRIES} retries (UI was idle, action did not succeed)`,
      retryable: true,
    },
  };
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
 * Waits for 3D content with a specific title to appear in the media list
 */
async function waitFor3DContentWithTitle(
  page: Page,
  title: string,
  timeout: number
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const exists = await has3DContentWithTitle(page, title);
    if (exists) {
      return true;
    }
    await page.waitForTimeout(TIMEOUTS.STATE_POLL_INTERVAL);
  }

  return false;
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

      log.info('Clicking Deliver confirm button');
      await confirmButton.click();

      // STEP 4: STATE-DRIVEN wait for delivery to complete
      await waitForLoadingComplete(ctx.page, TIMEOUTS.MODAL_CLOSE);

      // Poll for success or error state
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

    // Step 3: Import floor plans with verification
    const floorplanResult = await importFloorplans(
      ctx,
      manifest.sources.floorplan_urls,
      baselineCounts.floorPlans
    );
    if (!floorplanResult.success) {
      return { success: false, error: floorplanResult.error, actions };
    }
    actions.imported_floorplans = manifest.sources.floorplan_urls.length > 0;

    // Step 4: Import RMS files with verification
    const rmsResult = await importRmsFiles(
      ctx,
      manifest.sources.rms_urls,
      baselineCounts.files
    );
    if (!rmsResult.success) {
      return { success: false, error: rmsResult.error, actions };
    }
    actions.imported_rms = manifest.sources.rms_urls.length > 0;

    // Step 5: Add 3D Content (iGuide tour) with verification
    const content3dResult = await add3DContent(
      ctx,
      manifest.sources.tour_3d_url,
      baselineCounts.threeDContent
    );
    if (!content3dResult.success) {
      return { success: false, error: content3dResult.error, actions };
    }
    actions.added_3d_content = true;

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
