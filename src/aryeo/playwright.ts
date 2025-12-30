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
  getMediaRow,
  getAddButtonForRow,
  getFromLinkOption,
  getImportUrlInput,
  getImportButton,
  getSetTitlesCheckbox,
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
} from './selectors.js';

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const ACTION_DELAY_MS = 500;

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

      await ctx.page.goto(listingEditUrl, { waitUntil: 'networkidle' });

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
      await ctx.page.waitForLoadState('domcontentloaded');
      await waitForLoadingComplete(ctx.page);

      // Verify we can see the Media section with expected rows
      const floorPlansRow = getMediaRow(ctx.page, TEXT.FLOOR_PLANS);
      await floorPlansRow.waitFor({ state: 'visible', timeout: 10000 });

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
 * Imports a single URL via the "From link" flow for Floor Plans or Files
 */
async function importFromLink(
  ctx: AutomationContext,
  rowLabel: string,
  url: string,
  checkSetTitlesFromFilenames: boolean,
  step: string,
  index: number
): Promise<{ success: true } | { success: false; error: DeliveryError }> {
  const log = logger.child({ run_id: ctx.runId, step, rowLabel, index, url });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      log.info({ attempt }, `Importing URL via "From link" for ${rowLabel}`);

      // Step 1: Find and click the Add button for this row
      const addButton = getAddButtonForRow(ctx.page, rowLabel);
      await addButton.waitFor({ state: 'visible', timeout: 10000 });
      await addButton.click();
      await delay(ACTION_DELAY_MS);

      // Step 2: Click "From link" option in dropdown/menu
      const fromLinkOption = getFromLinkOption(ctx.page);
      await fromLinkOption.waitFor({ state: 'visible', timeout: 5000 });
      await fromLinkOption.click();
      await delay(ACTION_DELAY_MS);

      // Step 3: Fill in the URL input
      const urlInput = getImportUrlInput(ctx.page);
      await urlInput.waitFor({ state: 'visible', timeout: 5000 });
      await urlInput.fill(url);
      await delay(ACTION_DELAY_MS);

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

      // Step 5: Click Import button
      const importButton = getImportButton(ctx.page);
      await importButton.waitFor({ state: 'visible', timeout: 5000 });
      await importButton.click();

      // Step 6: Wait for import to complete
      await waitForLoadingComplete(ctx.page, 30000);
      await delay(1000);

      // Check for error toast
      const errorToast = getErrorToast(ctx.page);
      if (await errorToast.isVisible()) {
        const errorText = await errorToast.textContent();
        throw new Error(`Import failed: ${errorText}`);
      }

      await takeScreenshot(ctx, step, `success_${index}`);
      log.info(`Successfully imported URL ${index + 1} for ${rowLabel}`);
      return { success: true };
    } catch (err) {
      log.warn({ attempt, error: err instanceof Error ? err.message : String(err) }, `Import attempt failed for ${rowLabel}`);

      await takeScreenshot(ctx, step, `error_attempt_${attempt}_${index}`);

      // Try to close any open dialogs/modals before retry
      try {
        await ctx.page.keyboard.press('Escape');
        await delay(500);
      } catch {
        // Ignore
      }

      if (attempt < MAX_RETRIES) {
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  return {
    success: false,
    error: {
      code: ErrorCodes.ARYEO_IMPORT_FAILED,
      message: `Failed to import URL for ${rowLabel} after retries: ${url}`,
      retryable: true,
    },
  };
}

/**
 * Imports all floor plan URLs
 */
async function importFloorplans(
  ctx: AutomationContext,
  urls: string[]
): Promise<{ success: true } | { success: false; error: DeliveryError }> {
  const log = logger.child({ run_id: ctx.runId, count: urls.length });

  if (urls.length === 0) {
    log.info('No floor plan URLs to import, skipping');
    return { success: true };
  }

  log.info('Starting floor plan imports');

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    if (!url) continue;

    const result = await importFromLink(
      ctx,
      TEXT.FLOOR_PLANS,
      url,
      true, // Check "Set titles from filenames" for floor plans
      Steps.IMPORT_FLOORPLAN,
      i
    );

    if (!result.success) {
      return result;
    }

    // Small delay between imports
    if (i < urls.length - 1) {
      await delay(1000);
    }
  }

  log.info({ count: urls.length }, 'All floor plans imported successfully');
  return { success: true };
}

/**
 * Imports all RMS URLs (into the Files row)
 */
async function importRmsFiles(
  ctx: AutomationContext,
  urls: string[]
): Promise<{ success: true } | { success: false; error: DeliveryError }> {
  const log = logger.child({ run_id: ctx.runId, count: urls.length });

  if (urls.length === 0) {
    log.info('No RMS URLs to import, skipping');
    return { success: true };
  }

  log.info('Starting RMS file imports');

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    if (!url) continue;

    const result = await importFromLink(
      ctx,
      TEXT.FILES,
      url,
      false, // No "Set titles from filenames" for Files/RMS
      Steps.IMPORT_RMS,
      i
    );

    if (!result.success) {
      return result;
    }

    // Small delay between imports
    if (i < urls.length - 1) {
      await delay(1000);
    }
  }

  log.info({ count: urls.length }, 'All RMS files imported successfully');
  return { success: true };
}

/**
 * Adds 3D Content (iGuide tour) via the modal
 */
async function add3DContent(
  ctx: AutomationContext,
  tourUrl: string
): Promise<{ success: true } | { success: false; error: DeliveryError }> {
  const log = logger.child({ run_id: ctx.runId, step: Steps.ADD_3D_CONTENT, tourUrl });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      log.info({ attempt }, 'Adding 3D Content');

      // Step 1: Find and click the Add button for 3D Content row
      const addButton = getAddButtonForRow(ctx.page, TEXT.THREE_D_CONTENT);
      await addButton.waitFor({ state: 'visible', timeout: 10000 });
      await addButton.click();
      await delay(ACTION_DELAY_MS);

      // Step 2: Wait for modal to appear
      const modal = get3DContentModal(ctx.page);
      await modal.waitFor({ state: 'visible', timeout: 5000 });

      // Step 3: Fill in Content Title (always "iGuide 3D Virtual Tour")
      const titleInput = getContentTitleInput(ctx.page);
      await titleInput.waitFor({ state: 'visible', timeout: 5000 });
      await titleInput.fill(TEXT.IGUIDE_TITLE);
      await delay(ACTION_DELAY_MS);

      // Step 4: Fill in Content Link (tour URL)
      const linkInput = getContentLinkInput(ctx.page);
      await linkInput.waitFor({ state: 'visible', timeout: 5000 });
      await linkInput.fill(tourUrl);
      await delay(ACTION_DELAY_MS);

      // Step 5: Select Display Type "Both (Branded + Unbranded)"
      // This is a native <select> element, so use selectOption
      const displayDropdown = getDisplayTypeDropdown(ctx.page);
      try {
        await displayDropdown.waitFor({ state: 'visible', timeout: 3000 });
        // Use value="both" to select the option
        await displayDropdown.selectOption({ value: 'both' });
        await delay(ACTION_DELAY_MS);
        log.debug('Selected Display Type: Both (Branded + Unbranded)');
      } catch {
        log.debug('Display Type dropdown not found or not selectable, using default');
      }

      // Step 6: Click Add Content button
      const addContentButton = getAddContentButton(ctx.page);
      await addContentButton.waitFor({ state: 'visible', timeout: 5000 });
      await addContentButton.click();

      // Step 7: Wait for modal to close and content to be added
      await waitForLoadingComplete(ctx.page, 15000);
      await delay(1000);

      // Check for error toast
      const errorToast = getErrorToast(ctx.page);
      if (await errorToast.isVisible()) {
        const errorText = await errorToast.textContent();
        throw new Error(`Add 3D Content failed: ${errorText}`);
      }

      await takeScreenshot(ctx, Steps.ADD_3D_CONTENT, 'success');
      log.info('3D Content added successfully');
      return { success: true };
    } catch (err) {
      log.warn({ attempt, error: err instanceof Error ? err.message : String(err) }, 'Add 3D Content attempt failed');

      await takeScreenshot(ctx, Steps.ADD_3D_CONTENT, `error_attempt_${attempt}`);

      // Try to close any open modal before retry
      try {
        await ctx.page.keyboard.press('Escape');
        await delay(500);
      } catch {
        // Ignore
      }

      if (attempt < MAX_RETRIES) {
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  return {
    success: false,
    error: {
      code: ErrorCodes.ARYEO_3D_CONTENT_FAILED,
      message: 'Failed to add 3D Content after retries',
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
      await saveButton.waitFor({ state: 'visible', timeout: 10000 });
      await saveButton.click();

      // Wait for save to complete
      await waitForLoadingComplete(ctx.page, 30000);
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
      await deliverButton.waitFor({ state: 'visible', timeout: 10000 });
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
      await waitForLoadingComplete(ctx.page, 30000);
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
  log.info('Starting Aryeo delivery automation');

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

    // Step 2: Import floor plans
    const floorplanResult = await importFloorplans(ctx, manifest.sources.floorplan_urls);
    if (!floorplanResult.success) {
      return { success: false, error: floorplanResult.error, actions };
    }
    actions.imported_floorplans = manifest.sources.floorplan_urls.length > 0;

    // Step 3: Import RMS files
    const rmsResult = await importRmsFiles(ctx, manifest.sources.rms_urls);
    if (!rmsResult.success) {
      return { success: false, error: rmsResult.error, actions };
    }
    actions.imported_rms = manifest.sources.rms_urls.length > 0;

    // Step 4: Add 3D Content (iGuide tour)
    const content3dResult = await add3DContent(ctx, manifest.sources.tour_3d_url);
    if (!content3dResult.success) {
      return { success: false, error: content3dResult.error, actions };
    }
    actions.added_3d_content = true;

    // Step 5: Save the listing
    const saveResult = await saveListing(ctx);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error, actions };
    }
    actions.saved = true;

    // Step 6: Conditionally deliver to client
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
