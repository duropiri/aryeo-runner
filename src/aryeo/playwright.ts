import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
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

      // Wait for page to stabilize (avoid networkidle)
      await delay(2000);

      // Check if we're still logged in
      if (!(await isLoggedIn(ctx.page))) {
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

      // Wait for the Media section to be visible
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
 * Imports a single URL via the "From link" flow for Floor Plans or Files.
 *
 * CRITICAL: This function now properly waits for staging, clicks the commit button,
 * waits for modal close, and verifies the count incremented.
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

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      log.info({ attempt }, `Importing URL via "From link" for ${rowLabel}`);

      // Step 1: Find and click the Add button for this row
      const addButton = getAddButtonForRow(ctx.page, rowLabel);
      await addButton.waitFor({ state: 'visible', timeout: TIMEOUTS.ELEMENT_VISIBLE });
      await addButton.click();
      log.debug('Clicked Add button');
      await delay(TIMEOUTS.ACTION_DELAY);

      // Step 2: Click "From link" option in dropdown/menu
      const fromLinkOption = getFromLinkOption(ctx.page);
      await fromLinkOption.waitFor({ state: 'visible', timeout: 5000 });
      await fromLinkOption.click();
      log.debug('Clicked "From link" option');
      await delay(TIMEOUTS.ACTION_DELAY);

      // Step 3: Fill in the URL input
      const urlInput = getImportUrlInput(ctx.page);
      await urlInput.waitFor({ state: 'visible', timeout: 5000 });
      await urlInput.fill(url);
      log.debug('Filled URL input');
      await delay(TIMEOUTS.ACTION_DELAY);

      // Step 4: Check "Set titles from filenames" if required (Floor Plans only)
      if (checkSetTitlesFromFilenames) {
        const checkbox = getSetTitlesCheckbox(ctx.page);
        try {
          await checkbox.waitFor({ state: 'visible', timeout: 3000 });
          const isChecked = await checkbox.isChecked();
          if (!isChecked) {
            await checkbox.check();
            log.debug('Checked "Set titles from filenames" checkbox');
          }
        } catch {
          log.debug('Set titles checkbox not found, skipping');
        }
      }

      // Step 5: Click Import button to START STAGING
      const importButton = getImportButton(ctx.page);
      await importButton.waitFor({ state: 'visible', timeout: 5000 });
      await importButton.click();
      log.debug('Clicked Import button - staging started');

      // Step 6: Wait for file to be STAGED (preview appears)
      // The staging process downloads/processes the file, then shows a preview
      log.info('Waiting for file to be staged...');
      const stagedPreview = getStagedFilePreview(ctx.page);
      try {
        await stagedPreview.waitFor({ state: 'visible', timeout: TIMEOUTS.URL_STAGING });
        log.debug('File staged - preview visible');
      } catch (stagingErr) {
        // Check for error toast during staging
        const errorToast = getErrorToast(ctx.page);
        if (await errorToast.isVisible()) {
          const errorText = await errorToast.textContent();
          throw new Error(`Staging failed: ${errorText}`);
        }
        throw new Error(`Staging timeout: file did not appear in staging area within ${TIMEOUTS.URL_STAGING}ms`);
      }

      // Step 7: Wait for the COMMIT button ("Add 1 File" or "Add X Files") to be enabled
      log.info('Waiting for commit button to be enabled...');
      const commitButton = getCommitFilesButton(ctx.page);
      try {
        await commitButton.waitFor({ state: 'visible', timeout: TIMEOUTS.COMMIT_BUTTON_ENABLED });
        // Wait for it to be enabled (not disabled) using evaluate
        await ctx.page.waitForFunction(
          `(() => {
            const btn = document.querySelector('button.bg-primary, button[class*="bg-primary"]');
            return btn && !btn.disabled;
          })()`,
          { timeout: TIMEOUTS.COMMIT_BUTTON_ENABLED }
        );
        log.debug('Commit button is enabled');
      } catch {
        await takeScreenshot(ctx, step, `commit_button_not_ready_${attempt}`);
        throw new Error('Commit button ("Add X Files") did not become enabled');
      }

      // Step 8: CLICK THE COMMIT BUTTON - THIS IS THE KEY FIX
      log.info('Clicking commit button to add file to listing...');
      await commitButton.click();
      log.debug('Clicked commit button');

      // Step 9: Wait for modal/upload sheet to CLOSE
      log.info('Waiting for upload modal to close...');
      const uploadModal = getUploadModal(ctx.page);
      try {
        await uploadModal.waitFor({ state: 'hidden', timeout: TIMEOUTS.MODAL_CLOSE });
        log.debug('Upload modal closed');
      } catch {
        // Modal might already be closed or have different structure
        log.debug('Modal close wait timed out - checking if upload succeeded anyway');
      }

      // Give UI time to update
      await delay(1500);

      // Step 10: VERIFY the file was actually added
      log.info('Verifying file was added to listing...');
      const currentCount = await getMediaRowCount(ctx.page, rowLabel);
      const expectedMinCount = baselineCount + index + 1; // index is 0-based

      if (currentCount >= expectedMinCount) {
        log.info({ baselineCount, currentCount, expectedMinCount }, 'Post-condition VERIFIED: count increased');
      } else {
        // Count didn't increase - try waiting a bit more
        const verified = await waitForCountIncrement(ctx, rowLabel, baselineCount + index, TIMEOUTS.POST_VERIFY);
        if (!verified) {
          await takeScreenshot(ctx, step, `count_not_incremented_${attempt}`);
          throw new Error(`Post-condition FAILED: ${rowLabel} count did not increase (baseline: ${baselineCount}, current: ${currentCount}, expected at least: ${expectedMinCount})`);
        }
      }

      // Check for error toast
      const errorToast = getErrorToast(ctx.page);
      if (await errorToast.isVisible()) {
        const errorText = await errorToast.textContent();
        throw new Error(`Import failed with error: ${errorText}`);
      }

      await takeScreenshot(ctx, step, `success_${index}`);
      log.info(`Successfully imported URL ${index + 1} for ${rowLabel} - VERIFIED`);
      return { success: true };

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn({ attempt, error: errorMessage }, `Import attempt failed for ${rowLabel}`);

      await takeScreenshot(ctx, step, `error_attempt_${attempt}_${index}`);

      // Try to close any open dialogs/modals before retry
      try {
        await ctx.page.keyboard.press('Escape');
        await delay(500);
        await ctx.page.keyboard.press('Escape');
        await delay(500);
      } catch {
        // Ignore
      }

      if (attempt < MAX_RETRIES) {
        log.info(`Retrying import in ${RETRY_DELAY_MS}ms...`);
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  return {
    success: false,
    error: {
      code: ErrorCodes.ARYEO_IMPORT_FAILED,
      message: `Failed to import URL for ${rowLabel} after ${MAX_RETRIES} retries: ${url}`,
      retryable: true,
    },
  };
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
 * FIXED: Always uses exact title "iGuide 3D Virtual Tour" and selects
 * "Both (Branded + Unbranded)" display type. Verifies addition succeeded.
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

      // Step 1: Find and click the Add button for 3D Content row
      const addButton = getAddButtonForRow(ctx.page, TEXT.THREE_D_CONTENT);
      await addButton.waitFor({ state: 'visible', timeout: TIMEOUTS.ELEMENT_VISIBLE });
      await addButton.click();
      log.debug('Clicked Add button for 3D Content');
      await delay(TIMEOUTS.ACTION_DELAY);

      // Step 2: Wait for modal to appear
      const modal = get3DContentModal(ctx.page);
      await modal.waitFor({ state: 'visible', timeout: 5000 });
      log.debug('3D Content modal appeared');

      // Step 3: Fill in Content Title - ALWAYS "iGuide 3D Virtual Tour"
      const titleInput = getContentTitleInput(ctx.page);
      await titleInput.waitFor({ state: 'visible', timeout: 5000 });
      await titleInput.clear();
      await titleInput.fill(TEXT.IGUIDE_TITLE);
      log.info({ title: TEXT.IGUIDE_TITLE }, 'Filled Content Title');
      await delay(TIMEOUTS.ACTION_DELAY);

      // Step 4: Fill in Content Link (tour URL)
      const linkInput = getContentLinkInput(ctx.page);
      await linkInput.waitFor({ state: 'visible', timeout: 5000 });
      await linkInput.clear();
      await linkInput.fill(tourUrl);
      log.info({ url: tourUrl }, 'Filled Content Link');
      await delay(TIMEOUTS.ACTION_DELAY);

      // Step 5: Select Display Type "Both (Branded + Unbranded)" - ALWAYS
      const displayDropdown = getDisplayTypeDropdown(ctx.page);
      try {
        await displayDropdown.waitFor({ state: 'visible', timeout: 3000 });
        // Try multiple selection strategies
        try {
          await displayDropdown.selectOption({ value: 'both' });
          log.info('Selected Display Type: Both (using value="both")');
        } catch {
          try {
            await displayDropdown.selectOption({ label: TEXT.DISPLAY_BOTH });
            log.info('Selected Display Type: Both (using label)');
          } catch {
            // Last resort: click the option directly
            await displayDropdown.click();
            await delay(300);
            const option = ctx.page.locator('option').filter({ hasText: /both/i });
            await option.click();
            log.info('Selected Display Type: Both (clicked option)');
          }
        }
      } catch (dropdownErr) {
        log.warn({ error: dropdownErr instanceof Error ? dropdownErr.message : String(dropdownErr) },
          'Display Type dropdown not found or not selectable - may use default');
        await takeScreenshot(ctx, Steps.ADD_3D_CONTENT, `dropdown_issue_${attempt}`);
      }
      await delay(TIMEOUTS.ACTION_DELAY);

      // Step 6: Click Add Content button
      const addContentButton = getAddContentButton(ctx.page);
      await addContentButton.waitFor({ state: 'visible', timeout: 5000 });
      log.info('Clicking Add Content button...');
      await addContentButton.click();

      // Step 7: Wait for modal to close
      log.info('Waiting for 3D Content modal to close...');
      try {
        await modal.waitFor({ state: 'hidden', timeout: TIMEOUTS.MODAL_CLOSE });
        log.debug('3D Content modal closed');
      } catch {
        log.debug('Modal close wait timed out - checking success anyway');
      }

      // Give UI time to update
      await delay(1500);

      // Step 8: VERIFY the content was actually added
      log.info('Verifying 3D Content was added...');

      // Method 1: Check if item with title appears
      const contentExists = await has3DContentWithTitle(ctx.page, TEXT.IGUIDE_TITLE);
      if (contentExists) {
        log.info('Post-condition VERIFIED: 3D Content with title visible');
        await takeScreenshot(ctx, Steps.ADD_3D_CONTENT, 'success');
        return { success: true };
      }

      // Method 2: Check if count incremented
      const currentCount = await getMediaRowCount(ctx.page, TEXT.THREE_D_CONTENT);
      if (currentCount > baselineCount) {
        log.info({ baselineCount, currentCount }, 'Post-condition VERIFIED: 3D Content count increased');
        await takeScreenshot(ctx, Steps.ADD_3D_CONTENT, 'success');
        return { success: true };
      }

      // Method 3: Wait a bit longer for count change
      const verified = await waitForCountIncrement(ctx, TEXT.THREE_D_CONTENT, baselineCount, TIMEOUTS.POST_VERIFY);
      if (verified) {
        await takeScreenshot(ctx, Steps.ADD_3D_CONTENT, 'success');
        log.info('3D Content added and VERIFIED');
        return { success: true };
      }

      // Check for error toast
      const errorToast = getErrorToast(ctx.page);
      if (await errorToast.isVisible()) {
        const errorText = await errorToast.textContent();
        throw new Error(`Add 3D Content failed: ${errorText}`);
      }

      // If we get here, verification failed
      await takeScreenshot(ctx, Steps.ADD_3D_CONTENT, `verification_failed_${attempt}`);
      throw new Error(`Post-condition FAILED: 3D Content not visible after add (baseline: ${baselineCount}, current: ${currentCount})`);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn({ attempt, error: errorMessage }, 'Add 3D Content attempt failed');

      await takeScreenshot(ctx, Steps.ADD_3D_CONTENT, `error_attempt_${attempt}`);

      // Try to close any open modal before retry
      try {
        await ctx.page.keyboard.press('Escape');
        await delay(500);
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
      code: ErrorCodes.ARYEO_3D_CONTENT_FAILED,
      message: `Failed to add 3D Content after ${MAX_RETRIES} retries`,
      retryable: true,
    },
  };
}

/**
 * Saves the listing changes
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
      await saveButton.click();

      // Wait for save to complete
      await waitForLoadingComplete(ctx.page, TIMEOUTS.MODAL_CLOSE);
      await delay(2000);

      // Check for success toast
      const successToast = getSuccessToast(ctx.page);
      try {
        await successToast.waitFor({ state: 'visible', timeout: 5000 });
        log.debug('Success toast appeared');
      } catch {
        // Success toast might not appear, that's OK
      }

      // Check for error toast
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
 * Delivers the listing / sends to client
 */
async function deliverListing(
  ctx: AutomationContext
): Promise<{ success: true } | { success: false; error: DeliveryError }> {
  const log = logger.child({ run_id: ctx.runId, step: Steps.DELIVER_LISTING });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      log.info({ attempt }, 'Delivering listing');

      // Step 1: Click the "Deliver Listing" or "Re-deliver Listing" button
      const deliverButton = getDeliverButton(ctx.page);
      await deliverButton.waitFor({ state: 'visible', timeout: TIMEOUTS.ELEMENT_VISIBLE });
      await deliverButton.click();
      log.debug('Clicked Deliver Listing button');

      // Step 2: Wait for the delivery modal to appear
      const modal = getDeliverConfirmModal(ctx.page);
      await modal.waitFor({ state: 'visible', timeout: 5000 });
      log.debug('Delivery modal appeared');
      await delay(500);

      // Step 3: Click the "Deliver" confirm button in the modal
      const confirmButton = getDeliverConfirmButton(ctx.page);
      await confirmButton.waitFor({ state: 'visible', timeout: 5000 });
      log.info('Clicking Deliver confirm button');
      await confirmButton.click();

      // Wait for delivery to complete
      await waitForLoadingComplete(ctx.page, TIMEOUTS.MODAL_CLOSE);
      await delay(2000);

      // Check for success
      const successToast = getSuccessToast(ctx.page);
      try {
        await successToast.waitFor({ state: 'visible', timeout: 5000 });
        log.debug('Delivery success toast appeared');
      } catch {
        // Success toast might not appear
      }

      // Check for error
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
