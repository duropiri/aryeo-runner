/**
 * Aryeo UI Selectors and Locator Strategies
 *
 * This file contains all selectors and locator strategies for Aryeo automation.
 * Uses Playwright's recommended locator patterns (getByRole, getByText, etc.)
 *
 * When the Aryeo UI changes, update selectors here in one place.
 */

import type { Page, Locator } from 'playwright';

// ============================================================================
// TIMEOUTS (centralized for easy tuning)
// ============================================================================

export const TIMEOUTS = {
  // Phase 1: Wait for Add button to become enabled after clicking Import (server-side processing)
  ADD_BUTTON_ENABLED: 90000,
  // Phase 2: Wait for count verification after clicking Add (with exponential backoff)
  COUNT_VERIFICATION: 90000,
  // Modal close after commit
  MODAL_CLOSE: 45000,
  // Post-condition verification (count changed, item appeared)
  POST_VERIFY: 60000,
  // Default element visibility
  ELEMENT_VISIBLE: 10000,
  // State polling interval (how often to check UI state)
  STATE_POLL_INTERVAL: 500,
  // Time to wait for media section re-render after modal closes
  MEDIA_SECTION_RERENDER: 15000,
  // Exponential backoff intervals for count verification
  BACKOFF_INTERVALS: [2000, 4000, 8000, 15000, 30000] as readonly number[],
  // Extended backoff for post-reload verification
  POST_RELOAD_VERIFY: 30000,
  // Checkbox interaction timeout
  CHECKBOX_INTERACT: 5000,
} as const;

// ============================================================================
// TEXT CONSTANTS (for easy updates)
// ============================================================================

export const TEXT = {
  // Media section row labels
  IMAGES: 'Images',
  VIDEOS: 'Videos',
  FLOOR_PLANS: 'Floor Plans',
  THREE_D_CONTENT: '3D Content',
  FILES: 'Files',

  // Button labels
  ADD: 'Add',
  FROM_LINK: 'From link',
  IMPORT_FROM_LINK: 'Import from link',
  IMPORT: 'Import',
  SAVE: 'Save',
  SAVE_CHANGES: 'Save Changes',
  DELIVER: 'Deliver',
  DELIVER_LISTING: 'Deliver Listing',
  SEND_TO_CLIENT: 'Send to Client',
  ADD_CONTENT: 'Add Content',
  CONFIRM: 'Confirm',
  YES: 'Yes',

  // Checkbox labels
  SET_TITLES_FROM_FILENAMES: 'Set titles from filenames',

  // 3D Content modal
  CONTENT_TITLE: 'Content Title',
  CONTENT_LINK: 'Content Link',
  DISPLAY_TYPE: 'Display Type',
  DISPLAY_BOTH: 'Both (Branded + Unbranded)',
  IGUIDE_TITLE: 'iGuide 3D Virtual Tour',

  // Navigation/status
  MEDIA: 'Media',
  DASHBOARD: 'Dashboard',
  LISTINGS: 'Listings',
} as const;

// ============================================================================
// MEDIA SECTION LOCATORS
// ============================================================================

/**
 * Gets the Media section container
 */
export function getMediaSection(page: Page): Locator {
  return page.locator('h2').filter({ hasText: 'Media' }).locator('xpath=ancestor::div[1]');
}

/**
 * Gets a specific media row by its label (Images, Floor Plans, etc.)
 * The structure is: div[data-draggable] > div > div > div.bg-white contains the row
 * Inside: span.text-heading contains the label text
 */
export function getMediaRow(page: Page, rowLabel: string): Locator {
  // Find the span with the exact label, then go up to the draggable container
  return page
    .locator('span.text-heading')
    .filter({ hasText: rowLabel })
    .locator('xpath=ancestor::div[@data-draggable="true"][1]');
}

/**
 * Gets the Add button for a specific media row
 * The Add button has class bg-primary and contains a span with text "Add"
 */
export function getAddButtonForRow(page: Page, rowLabel: string): Locator {
  const row = getMediaRow(page, rowLabel);
  // Find the primary button with "Add" text within this row
  return row.locator('button.bg-primary, button[class*="bg-primary"]').filter({ hasText: TEXT.ADD });
}

/**
 * Alternative: Get Add button by finding the row label span and navigating to Add button
 */
export function getAddButtonNearLabel(page: Page, rowLabel: string): Locator {
  // Find the label span, go up to the row container, find the Add button
  return page
    .locator('span.text-heading')
    .filter({ hasText: rowLabel })
    .locator('xpath=ancestor::div[@data-draggable="true"][1]')
    .locator('button')
    .filter({ hasText: TEXT.ADD })
    .last(); // The Add button is typically the last button in the row
}

// ============================================================================
// COUNT BADGE LOCATORS
// ============================================================================

/**
 * Gets the count badge for a media row.
 * The count is typically shown as a badge like "(2)" or in the label text.
 * Structure: <span class="text-heading">Floor Plans</span><span class="badge">(2)</span>
 * Or embedded in label: "Floor Plans (2)"
 */
export function getMediaRowCountBadge(page: Page, rowLabel: string): Locator {
  const row = getMediaRow(page, rowLabel);
  // Try to find a badge/count element within the row header area
  return row.locator('span.badge, span[class*="count"], span[class*="badge"]').first()
    .or(row.locator('span').filter({ hasText: /^\(\d+\)$/ }).first());
}

/**
 * Parses the count from a media row label or badge.
 * Returns 0 if count cannot be determined.
 */
export async function getMediaRowCount(page: Page, rowLabel: string): Promise<number> {
  const row = getMediaRow(page, rowLabel);

  try {
    // Strategy 1: Look for the label span and extract count from text like "Floor Plans (2)"
    const labelSpan = row.locator('span.text-heading').first();
    const labelText = await labelSpan.textContent({ timeout: 5000 });
    if (labelText) {
      const match = labelText.match(/\((\d+)\)/);
      if (match && match[1]) {
        return parseInt(match[1], 10);
      }
    }

    // Strategy 2: Look for separate badge element
    const badge = getMediaRowCountBadge(page, rowLabel);
    if (await badge.isVisible({ timeout: 2000 })) {
      const badgeText = await badge.textContent();
      if (badgeText) {
        const match = badgeText.match(/(\d+)/);
        if (match && match[1]) {
          return parseInt(match[1], 10);
        }
      }
    }

    // Strategy 3: Count visible items in the row's content area
    // This is a fallback - count the actual media items displayed
    const items = row.locator('[class*="item"], [class*="thumbnail"], [class*="preview"], li, img').first();
    const itemCount = await items.count();
    if (itemCount > 0) {
      return itemCount;
    }
  } catch {
    // Could not determine count
  }

  return 0;
}

// ============================================================================
// UPLOAD DIALOG / DROPDOWN LOCATORS
// ============================================================================

/**
 * Gets the upload sheet/panel that appears after clicking Add
 * This is the Uploadcare widget container
 */
export function getUploadSheet(page: Page): Locator {
  return page.locator('uc-file-uploader-inline');
}

/**
 * Gets the "From link" option in the upload source list
 * Structure: <uc-source-btn type="url"><button>...<div class="uc-txt">From link</div></button></uc-source-btn>
 */
export function getFromLinkOption(page: Page): Locator {
  return page.locator('uc-source-btn[type="url"] button')
    .or(page.locator('.uc-txt').filter({ hasText: 'From link' }).locator('xpath=ancestor::button[1]'));
}

/**
 * Gets the URL input in the "Import from link" view
 * Structure: <uc-url-source><form><input class="uc-url-input" placeholder="https://"></form></uc-url-source>
 */
export function getImportUrlInput(page: Page): Locator {
  return page.locator('uc-url-source input.uc-url-input')
    .or(page.locator('input[placeholder="https://"]'));
}

/**
 * Gets the Import button in the URL source view
 * Structure: <button class="uc-url-upload-btn uc-primary-btn">Import</button>
 */
export function getImportButton(page: Page): Locator {
  return page.locator('uc-url-source button.uc-url-upload-btn')
    .or(page.locator('button.uc-primary-btn').filter({ hasText: 'Import' }));
}

/**
 * Gets the "Set titles from filenames" checkbox (Floor Plans only)
 * IMPORTANT: Must target the actual input element, not the label!
 * Structure: <label id="set_titles"><input name="set_titles" type="checkbox">...<div>Set titles from filenames</div></label>
 */
export function getSetTitlesCheckbox(page: Page): Locator {
  // Primary: Use role-based selector (recommended by Playwright)
  return page.getByRole('checkbox', { name: /set titles from filenames/i })
    // Fallback: Find the input inside the label
    .or(page.locator('label#set_titles input[type="checkbox"]'))
    .or(page.locator('label').filter({ hasText: /set titles from filenames/i }).locator('input[type="checkbox"]'))
    .or(page.locator('input[name="set_titles"]'));
}

/**
 * Gets the label for "Set titles from filenames" checkbox (for clicking if checkbox is hidden)
 */
export function getSetTitlesLabel(page: Page): Locator {
  return page.locator('label#set_titles')
    .or(page.locator('label').filter({ hasText: /set titles from filenames/i }));
}

/**
 * Gets the "Add X Files" button at the bottom of the upload sheet
 * This is the COMMIT button that must be clicked after staging files
 */
export function getAddFilesButton(page: Page): Locator {
  return page.locator('button.bg-primary').filter({ hasText: /Add \d+ Files?/i })
    .or(page.locator('button[variant="primary"]').filter({ hasText: /Add.*Files?/i }))
    .or(page.getByRole('button', { name: /^Add \d+ Files?$/i }));
}

/**
 * Gets the commit button by looking for "Add 1 File" or "Add X Files" patterns
 * More specific than getAddFilesButton - looks for exact button styles
 */
export function getCommitFilesButton(page: Page): Locator {
  // The commit button is typically a primary button at the bottom of the upload modal
  // with text like "Add 1 File" or "Add 3 Files"
  return page.locator('button.bg-primary, button[class*="bg-primary"]')
    .filter({ hasText: /^Add \d+ Files?$/i })
    .or(page.locator('uc-file-uploader-inline button.uc-primary-btn').filter({ hasText: /Add/i }))
    .or(page.locator('[class*="modal"] button.bg-primary').filter({ hasText: /Add.*File/i }));
}

/**
 * Gets the upload modal/sheet container
 */
export function getUploadModal(page: Page): Locator {
  return page.locator('uc-file-uploader-inline')
    .or(page.locator('[class*="upload"][class*="modal"]'))
    .or(page.locator('[role="dialog"]').filter({ hasText: /upload|add.*file/i }));
}

/**
 * Gets the staging/preview area that shows files ready to be committed
 * Uploadcare shows a preview of the file before the final "Add X Files" commit
 */
export function getStagedFilePreview(page: Page): Locator {
  return page.locator('uc-file-item, [class*="file-preview"], [class*="staged-file"], [class*="uc-file"]')
    .or(page.locator('uc-upload-list'))
    .or(page.locator('[class*="upload-list"]'));
}

/**
 * Checks if a file is currently staged (ready for commit)
 * Returns true if there's at least one staged file visible
 */
export async function hasStagedFiles(page: Page): Promise<boolean> {
  try {
    const staged = getStagedFilePreview(page);
    const count = await staged.count();
    return count > 0;
  } catch {
    return false;
  }
}

/**
 * Gets the Done button in the upload widget (after files are uploaded)
 */
export function getDoneButton(page: Page): Locator {
  return page.locator('button.uc-done-btn')
    .or(page.locator('button.uc-primary-btn').filter({ hasText: 'Done' }));
}

/**
 * Gets any cancel/close button in the upload modal
 */
export function getUploadCancelButton(page: Page): Locator {
  return page.locator('button').filter({ hasText: /cancel|close/i })
    .or(page.locator('[aria-label="Close"]'))
    .or(page.locator('button[class*="close"]'));
}

// ============================================================================
// 3D CONTENT MODAL LOCATORS
// ============================================================================

/**
 * Gets the 3D Content modal/dialog
 * The modal appears when clicking "Add" on the 3D Content row
 */
export function get3DContentModal(page: Page): Locator {
  // The modal should contain fields for title, link, and display type
  return page.getByRole('dialog')
    .or(page.locator('[class*="modal"]').filter({ hasText: /3D|content|tour/i }))
    .or(page.locator('div.shadow-xl').filter({ hasText: /Content Title|Content Link/i }));
}

/**
 * Gets the Content Title input in 3D Content modal
 * Structure: <input id="ContentTitle:" placeholder="Title">
 */
export function getContentTitleInput(page: Page): Locator {
  return page.locator('input#ContentTitle\\:')
    .or(page.locator('input[id="ContentTitle:"]'))
    .or(page.locator('input[id*="ContentTitle"]'))
    .or(page.getByPlaceholder('Title'))
    .or(page.locator('label').filter({ hasText: /Content Title/i }).locator('xpath=following-sibling::input[1]'));
}

/**
 * Gets the Content Link input in 3D Content modal
 * Structure: <input id="Pasteyourlinkbelow:" placeholder="Content Link">
 */
export function getContentLinkInput(page: Page): Locator {
  return page.locator('input#Pasteyourlinkbelow\\:')
    .or(page.locator('input[id="Pasteyourlinkbelow:"]'))
    .or(page.locator('input[id*="Pasteyourlink"]'))
    .or(page.getByPlaceholder('Content Link'))
    .or(page.locator('label').filter({ hasText: /link/i }).locator('xpath=following-sibling::input[1]'));
}

/**
 * Gets the Display Type dropdown/select in 3D Content modal
 * Structure: <select id="DisplayType">
 * Options: "branded", "unbranded", "both"
 */
export function getDisplayTypeDropdown(page: Page): Locator {
  return page.locator('select#DisplayType')
    .or(page.locator('select[id="DisplayType"]'))
    .or(page.locator('select[id*="DisplayType"]'))
    .or(page.getByRole('combobox', { name: /display type/i }))
    .or(page.locator('label').filter({ hasText: /Display Type/i }).locator('xpath=following-sibling::select[1]'));
}

/**
 * Gets the "Both (Branded + Unbranded)" option value
 * Structure: <option value="both">Both (Branded + Unbranded)</option>
 */
export function getDisplayTypeBothOption(page: Page): Locator {
  return page.locator('select#DisplayType option[value="both"]')
    .or(page.getByRole('option', { name: /both/i }));
}

/**
 * Gets the Add Content button in 3D Content modal
 * Structure: <button class="...bg-primary..."><span>Add Content</span></button>
 */
export function getAddContentButton(page: Page): Locator {
  return page.locator('button.bg-primary, button[class*="bg-primary"]').filter({ hasText: TEXT.ADD_CONTENT })
    .or(page.getByRole('button', { name: TEXT.ADD_CONTENT }));
}

// ============================================================================
// EXISTING 3D CONTENT DETECTION
// ============================================================================

/**
 * Checks if 3D content with a specific title already exists in the row
 */
export function get3DContentItemByTitle(page: Page, title: string): Locator {
  const row = getMediaRow(page, TEXT.THREE_D_CONTENT);
  return row.locator('[class*="content-item"], [class*="media-item"], li, div, span')
    .filter({ hasText: title });
}

/**
 * Gets all existing 3D content items in the 3D Content row
 */
export function getExisting3DContentItems(page: Page): Locator {
  const row = getMediaRow(page, TEXT.THREE_D_CONTENT);
  return row.locator('[class*="item"], [class*="content"], [class*="tour"]');
}

/**
 * Counts the number of 3D content items currently visible
 */
export async function count3DContentItems(page: Page): Promise<number> {
  try {
    const items = getExisting3DContentItems(page);
    return await items.count();
  } catch {
    return 0;
  }
}

/**
 * Checks if a specific 3D content (by title) already exists
 */
export async function has3DContentWithTitle(page: Page, title: string): Promise<boolean> {
  try {
    const item = get3DContentItemByTitle(page, title);
    return await item.isVisible({ timeout: 2000 });
  } catch {
    return false;
  }
}

// ============================================================================
// SAVE & DELIVER LOCATORS
// ============================================================================

/**
 * Gets the Save button
 */
export function getSaveButton(page: Page): Locator {
  return page.getByRole('button', { name: /^save$/i })
    .or(page.getByRole('button', { name: /save changes/i }))
    .or(page.locator('button[type="submit"]').filter({ hasText: /save/i }));
}

/**
 * Gets the "Deliver Listing" or "Re-deliver Listing" button (opens the modal)
 * Structure: <button class="...bg-primary..."><span>Deliver Listing</span></button>
 * or: <button class="...bg-primary..."><span>Re-deliver Listing</span></button>
 */
export function getDeliverButton(page: Page): Locator {
  return page.locator('button.bg-primary, button[class*="bg-primary"]').filter({ hasText: /^(Re-)?[Dd]eliver Listing$/ })
    .or(page.getByRole('button', { name: /^(Re-)?[Dd]eliver Listing$/ }));
}

/**
 * Gets the delivery confirmation modal
 * Structure: <div class="...shadow-xl...sm:max-w-2xl">...<span>Deliver Listing</span>...</div>
 */
export function getDeliverConfirmModal(page: Page): Locator {
  return page.locator('div.shadow-xl').filter({ hasText: TEXT.DELIVER_LISTING })
    .or(page.locator('[class*="modal"]').filter({ hasText: TEXT.DELIVER_LISTING }));
}

/**
 * Gets the "Deliver" confirm button in the delivery modal (not "Deliver Listing")
 * Structure: <button class="...bg-primary..."><span>Deliver</span></button>
 * Note: This is different from the initial "Deliver Listing" button
 */
export function getDeliverConfirmButton(page: Page): Locator {
  // Find the modal first, then look for the Deliver button inside it
  // The confirm button has text "Deliver" (not "Deliver Listing")
  return page.locator('div.shadow-xl button.bg-primary, div.shadow-xl button[class*="bg-primary"]')
    .filter({ hasText: /^Deliver$/ })
    .or(page.locator('button.bg-primary, button[class*="bg-primary"]').filter({ hasText: /^Deliver$/ }));
}

// ============================================================================
// STATUS & FEEDBACK LOCATORS
// ============================================================================

/**
 * Gets success toast/notification
 */
export function getSuccessToast(page: Page): Locator {
  return page.locator('[class*="toast"][class*="success"], [class*="notification"][class*="success"], [role="alert"]')
    .filter({ hasText: /success|saved|imported|added/i });
}

/**
 * Gets error toast/notification
 */
export function getErrorToast(page: Page): Locator {
  return page.locator('[class*="toast"][class*="error"], [class*="notification"][class*="error"], [role="alert"]')
    .filter({ hasText: /error|failed|invalid/i });
}

/**
 * Gets loading spinner/indicator
 */
export function getLoadingIndicator(page: Page): Locator {
  return page.locator('[class*="loading"], [class*="spinner"], [aria-busy="true"]');
}

// ============================================================================
// NAVIGATION LOCATORS
// ============================================================================

/**
 * Gets user menu (to verify logged in)
 */
export function getUserMenu(page: Page): Locator {
  return page.locator('[class*="user-menu"], [class*="avatar"], [class*="profile"]')
    .or(page.getByRole('button', { name: /account|profile|user/i }));
}

/**
 * Gets navigation links
 */
export function getNavLink(page: Page, name: string): Locator {
  return page.getByRole('link', { name: new RegExp(name, 'i') })
    .or(page.getByRole('navigation').getByText(name));
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Waits for any loading indicators to disappear
 */
export async function waitForLoadingComplete(page: Page, timeout = 30000): Promise<void> {
  try {
    await getLoadingIndicator(page).waitFor({ state: 'hidden', timeout });
  } catch {
    // No loading indicator found, that's OK
  }
}

/**
 * Waits for a success toast to appear
 */
export async function waitForSuccessToast(page: Page, timeout = 10000): Promise<boolean> {
  try {
    await getSuccessToast(page).waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks if an error toast is visible
 */
export async function isErrorToastVisible(page: Page): Promise<boolean> {
  try {
    return await getErrorToast(page).isVisible();
  } catch {
    return false;
  }
}

/**
 * Checks if user is logged in by looking for user menu
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    return await getUserMenu(page).isVisible();
  } catch {
    return false;
  }
}

/**
 * Clicks a button and waits for loading to complete
 */
export async function clickAndWaitForLoad(
  locator: Locator,
  page: Page,
  options?: { timeout?: number }
): Promise<void> {
  await locator.click();
  await waitForLoadingComplete(page, options?.timeout);
}

/**
 * Tries multiple locator strategies until one works
 */
export async function findFirstVisible(
  _page: Page,
  ...locators: Locator[]
): Promise<Locator | null> {
  for (const locator of locators) {
    try {
      if (await locator.isVisible()) {
        return locator;
      }
    } catch {
      // Continue to next locator
    }
  }
  return null;
}

/**
 * Waits for one of multiple locators to become visible
 */
export async function waitForAnyVisible(
  page: Page,
  locators: Locator[],
  timeout = 10000
): Promise<Locator | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    for (const locator of locators) {
      try {
        if (await locator.isVisible()) {
          return locator;
        }
      } catch {
        // Continue
      }
    }
    await page.waitForTimeout(100);
  }

  return null;
}

// ============================================================================
// STATE-DRIVEN UPLOAD DETECTION
// ============================================================================

/**
 * Upload UI state snapshot for diagnostics
 */
export interface UploadUIState {
  // Add button state - PRIMARY indicator for readiness
  addButtonVisible: boolean;
  addButtonEnabled: boolean;
  addButtonText: string | null;
  // Secondary indicators (for diagnostics, not blocking)
  hasProgressBar: boolean;
  progressPercent: number | null;
  hasSkeletonLoader: boolean;
  hasSpinnerInModal: boolean;
  // Error state
  hasErrorMessage: boolean;
  errorMessage: string | null;
  modalErrorText: string | null;
  // Current counts (for diagnostics)
  timestamp: number;
}

/**
 * Gets the upload progress bar element in the Uploadcare widget
 */
export function getUploadProgressBar(page: Page): Locator {
  return page.locator('uc-progress-bar, [class*="uc-progress"], [class*="progress-bar"], [role="progressbar"]')
    .or(page.locator('.uc-file-item [class*="progress"]'))
    .or(page.locator('uc-file-item [class*="uploading"]'));
}

/**
 * Gets skeleton/placeholder loaders in the upload widget
 */
export function getSkeletonLoader(page: Page): Locator {
  return page.locator('[class*="skeleton"], [class*="placeholder"], [class*="loading-placeholder"]')
    .or(page.locator('uc-file-item[data-state="uploading"]'))
    .or(page.locator('uc-file-item[data-state="processing"]'))
    .or(page.locator('.uc-file-item--uploading, .uc-file-item--processing'));
}

/**
 * Gets loading spinners specifically within the upload modal area
 */
export function getUploadModalSpinner(page: Page): Locator {
  return page.locator('uc-file-uploader-inline [class*="spinner"], uc-file-uploader-inline [class*="loading"]')
    .or(page.locator('uc-activity-icon, uc-spinner'))
    .or(page.locator('.uc-upload-list [aria-busy="true"]'));
}

/**
 * Gets any error message visible in the upload modal
 */
export function getModalErrorMessage(page: Page): Locator {
  return page.locator('uc-file-uploader-inline [class*="error"], uc-file-uploader-inline [class*="failed"]')
    .or(page.locator('[role="alert"]').filter({ hasText: /error|failed|invalid/i }))
    .or(page.locator('[class*="modal"] [class*="error"]'));
}

/**
 * Captures comprehensive UI state snapshot for diagnostics
 * CRITICAL: This function should NEVER throw - always return a valid state
 */
export async function getUploadUIState(page: Page): Promise<UploadUIState> {
  const state: UploadUIState = {
    addButtonVisible: false,
    addButtonEnabled: false,
    addButtonText: null,
    hasProgressBar: false,
    progressPercent: null,
    hasSkeletonLoader: false,
    hasSpinnerInModal: false,
    hasErrorMessage: false,
    errorMessage: null,
    modalErrorText: null,
    timestamp: Date.now(),
  };

  try {
    // PRIMARY: Check Add Files button state
    const addFilesButton = getCommitFilesButton(page);
    state.addButtonVisible = await addFilesButton.isVisible().catch(() => false);

    if (state.addButtonVisible) {
      state.addButtonEnabled = !(await addFilesButton.isDisabled().catch(() => true));
      state.addButtonText = await addFilesButton.textContent().catch(() => null);
    }

    // SECONDARY: Check for progress bar (informational only)
    const progressBar = getUploadProgressBar(page);
    state.hasProgressBar = await progressBar.isVisible().catch(() => false);

    if (state.hasProgressBar) {
      try {
        const progressValue = await progressBar.getAttribute('aria-valuenow');
        if (progressValue) {
          state.progressPercent = parseInt(progressValue, 10);
        } else {
          const style = await progressBar.getAttribute('style');
          if (style) {
            const widthMatch = style.match(/width:\s*(\d+(?:\.\d+)?)%/);
            if (widthMatch && widthMatch[1]) {
              state.progressPercent = parseFloat(widthMatch[1]);
            }
          }
        }
      } catch {
        // Could not extract percentage
      }
    }

    // SECONDARY: Check for skeleton loaders (informational only)
    state.hasSkeletonLoader = await getSkeletonLoader(page).isVisible().catch(() => false);

    // SECONDARY: Check for spinners (informational only)
    state.hasSpinnerInModal = await getUploadModalSpinner(page).isVisible().catch(() => false);

    // ERROR: Check for error messages
    const errorToast = getErrorToast(page);
    state.hasErrorMessage = await errorToast.isVisible().catch(() => false);
    if (state.hasErrorMessage) {
      state.errorMessage = await errorToast.textContent().catch(() => null);
    }

    // Check for modal-specific error
    const modalError = getModalErrorMessage(page);
    if (await modalError.isVisible().catch(() => false)) {
      state.modalErrorText = await modalError.textContent().catch(() => null);
      state.hasErrorMessage = true;
    }

  } catch {
    // Return partial state on error - never throw
  }

  return state;
}

/**
 * Checks if the UI is ready for clicking the Add button
 *
 * CRITICAL FIX: The PRIMARY condition is Add button enabled.
 * Skeleton loaders and progress bars should NOT block if the Add button is enabled.
 * For server-side URL imports, the file may never "stage" visually.
 */
export function isReadyToClickAdd(state: UploadUIState): boolean {
  // If there's an error, not ready
  if (state.hasErrorMessage) {
    return false;
  }

  // PRIMARY CONDITION: Add button must be visible AND enabled
  return state.addButtonVisible && state.addButtonEnabled;
}

/**
 * Checks if an upload error has occurred
 */
export function hasUploadError(state: UploadUIState): boolean {
  return state.hasErrorMessage || state.modalErrorText !== null;
}

/**
 * Gets the error message from state
 */
export function getUploadErrorMessage(state: UploadUIState): string | null {
  return state.modalErrorText || state.errorMessage || null;
}

/**
 * Waits for the Add button to become enabled (Phase 1)
 *
 * This is the ONLY condition we wait for. Skeleton loaders and progress bars
 * are logged but do NOT block the process if Add button is enabled.
 *
 * @returns Object with ready status and final state
 */
export async function waitForAddButtonEnabled(
  page: Page,
  timeout: number = TIMEOUTS.ADD_BUTTON_ENABLED
): Promise<{ ready: boolean; state: UploadUIState; reason: string }> {
  const startTime = Date.now();
  let lastState: UploadUIState = await getUploadUIState(page);
  let stableCount = 0;
  const requiredStableChecks = 2; // Must be stable for 2 consecutive checks

  while (Date.now() - startTime < timeout) {
    const currentState = await getUploadUIState(page);

    // Check for error state first
    if (hasUploadError(currentState)) {
      return {
        ready: false,
        state: currentState,
        reason: `Upload error: ${getUploadErrorMessage(currentState) || 'Unknown error'}`,
      };
    }

    // PRIMARY CHECK: Is Add button enabled?
    if (isReadyToClickAdd(currentState)) {
      stableCount++;
      if (stableCount >= requiredStableChecks) {
        return {
          ready: true,
          state: currentState,
          reason: 'Add button is enabled and ready',
        };
      }
    } else {
      stableCount = 0;
    }

    lastState = currentState;
    await page.waitForTimeout(TIMEOUTS.STATE_POLL_INTERVAL);
  }

  // Timeout - provide detailed reason
  const reason = buildTimeoutReason(lastState);
  return {
    ready: false,
    state: lastState,
    reason,
  };
}

/**
 * Builds a detailed timeout reason from the current state
 */
function buildTimeoutReason(state: UploadUIState): string {
  const issues: string[] = [];

  if (!state.addButtonVisible) {
    issues.push('Add button not visible');
  } else if (!state.addButtonEnabled) {
    issues.push('Add button visible but disabled');
  }

  if (state.hasProgressBar) {
    issues.push(`Progress bar visible (${state.progressPercent ?? 'unknown'}%)`);
  }

  if (state.hasSkeletonLoader) {
    issues.push('Skeleton loader visible');
  }

  if (state.hasSpinnerInModal) {
    issues.push('Spinner visible in modal');
  }

  if (state.hasErrorMessage) {
    issues.push(`Error: ${state.errorMessage || state.modalErrorText || 'unknown'}`);
  }

  return `Timeout waiting for Add button: ${issues.join(', ') || 'unknown issue'}`;
}

/**
 * Creates a compact UI snapshot for logging/diagnostics
 */
export function formatUISnapshot(state: UploadUIState): string {
  return JSON.stringify({
    addBtn: state.addButtonVisible ? (state.addButtonEnabled ? 'enabled' : 'disabled') : 'hidden',
    addText: state.addButtonText,
    progress: state.hasProgressBar ? (state.progressPercent ?? '?') + '%' : null,
    skeleton: state.hasSkeletonLoader,
    spinner: state.hasSpinnerInModal,
    error: state.hasErrorMessage ? (state.errorMessage || state.modalErrorText) : null,
  });
}

// Legacy exports for backwards compatibility
export const isUploadInProgress = (state: UploadUIState): boolean => {
  // If Add button is enabled, we're NOT in progress (even if skeleton is showing)
  if (state.addButtonVisible && state.addButtonEnabled) {
    return false;
  }
  // Otherwise, check for active indicators
  return state.hasProgressBar || state.hasSkeletonLoader || state.hasSpinnerInModal;
};

export const isUIReadyForCommit = isReadyToClickAdd;

export const waitForUploadReadyState = waitForAddButtonEnabled;

// ============================================================================
// ASSET EXISTENCE CHECK (PREFLIGHT & VERIFICATION)
// ============================================================================

/**
 * Result of checking if an asset exists in the media section
 */
export interface AssetExistsResult {
  exists: boolean;
  matchMethod: 'filename_text' | 'filename_attribute' | 'url_fragment' | 'none';
  matchedElement?: string; // Description of what matched
}

/**
 * Checks if an asset already exists in a media section row.
 *
 * This is the PREFLIGHT check that prevents duplicate imports.
 *
 * Search order:
 * 1. Text node containing the filename (decodedFilename)
 * 2. Element attribute containing filename (alt/title/aria-label/href/src)
 * 3. Fallback: URL's last path segment
 *
 * @param page - Playwright page
 * @param rowLabel - Media section row label (e.g., TEXT.FLOOR_PLANS)
 * @param decodedFilename - The decoded filename to search for
 * @param urlPathFragment - The last path segment from the URL (fallback)
 * @returns AssetExistsResult with exists status and match method
 */
export async function preflightAssetExists(
  page: Page,
  rowLabel: string,
  decodedFilename: string,
  urlPathFragment: string
): Promise<AssetExistsResult> {
  const row = getMediaRow(page, rowLabel);

  // Normalize filename for comparison (remove extension variations, etc.)
  const filenameNormalized = decodedFilename.toLowerCase().trim();
  const fragmentNormalized = urlPathFragment.toLowerCase().trim();

  try {
    // Strategy 1: Look for text node containing the filename
    if (decodedFilename) {
      // Use a case-insensitive search
      const textMatch = row.locator(`text=${decodedFilename}`)
        .or(row.locator(`*:has-text("${decodedFilename}")`));

      if (await textMatch.first().isVisible({ timeout: 1000 }).catch(() => false)) {
        return {
          exists: true,
          matchMethod: 'filename_text',
          matchedElement: `Text containing "${decodedFilename}"`,
        };
      }
    }

    // Strategy 2: Look for attribute containing the filename
    // Search in alt, title, aria-label, href, src attributes
    if (decodedFilename) {
      const attrSelectors = [
        `[alt*="${decodedFilename}" i]`,
        `[title*="${decodedFilename}" i]`,
        `[aria-label*="${decodedFilename}" i]`,
        `[href*="${encodeURIComponent(decodedFilename)}"]`,
        `[src*="${encodeURIComponent(decodedFilename)}"]`,
      ];

      for (const selector of attrSelectors) {
        try {
          const attrMatch = row.locator(selector).first();
          if (await attrMatch.isVisible({ timeout: 500 }).catch(() => false)) {
            return {
              exists: true,
              matchMethod: 'filename_attribute',
              matchedElement: `Attribute matching "${decodedFilename}"`,
            };
          }
        } catch {
          // Continue to next selector
        }
      }
    }

    // Strategy 3: Fallback - search for URL path fragment
    if (urlPathFragment && urlPathFragment !== decodedFilename) {
      const fragmentMatch = row.locator(`text=${urlPathFragment}`)
        .or(row.locator(`[href*="${urlPathFragment}"]`))
        .or(row.locator(`[src*="${urlPathFragment}"]`));

      if (await fragmentMatch.first().isVisible({ timeout: 500 }).catch(() => false)) {
        return {
          exists: true,
          matchMethod: 'url_fragment',
          matchedElement: `URL fragment "${urlPathFragment}"`,
        };
      }
    }

  } catch {
    // Search failed, assume not exists
  }

  return {
    exists: false,
    matchMethod: 'none',
  };
}

/**
 * Waits for an asset to appear in the media section with exponential backoff.
 * Used for POST-IMPORT verification.
 *
 * @param page - Playwright page
 * @param rowLabel - Media section row label
 * @param decodedFilename - The decoded filename to wait for
 * @param urlPathFragment - URL path fragment fallback
 * @param timeout - Maximum time to wait
 * @returns AssetExistsResult
 */
export async function waitForAssetExists(
  page: Page,
  rowLabel: string,
  decodedFilename: string,
  urlPathFragment: string,
  timeout: number = TIMEOUTS.COUNT_VERIFICATION
): Promise<AssetExistsResult> {
  const startTime = Date.now();
  const backoffIntervals = TIMEOUTS.BACKOFF_INTERVALS;
  let backoffIndex = 0;

  while (Date.now() - startTime < timeout) {
    const result = await preflightAssetExists(page, rowLabel, decodedFilename, urlPathFragment);
    if (result.exists) {
      return result;
    }

    // Wait with exponential backoff
    const waitTime = backoffIntervals[Math.min(backoffIndex, backoffIntervals.length - 1)] ?? 5000;
    await page.waitForTimeout(waitTime);
    backoffIndex++;
  }

  return {
    exists: false,
    matchMethod: 'none',
  };
}

/**
 * Dumps the HTML content of the upload modal for debugging.
 * Returns null if modal is not visible.
 */
export async function dumpUploadModalHtml(page: Page): Promise<string | null> {
  try {
    const modal = getUploadModal(page);
    if (await modal.isVisible({ timeout: 1000 }).catch(() => false)) {
      return await modal.innerHTML();
    }
  } catch {
    // Modal not found
  }
  return null;
}

// ============================================================================
// MEDIA SECTION VERIFICATION
// ============================================================================

/**
 * Gets all visible file items in a media row (for counting and verification)
 */
export function getMediaRowItems(page: Page, rowLabel: string): Locator {
  const row = getMediaRow(page, rowLabel);
  return row.locator('[class*="item"], [class*="file"], [class*="media"], li');
}

/**
 * Checks if a specific filename appears in the media row
 */
export async function hasFileInMediaRow(page: Page, rowLabel: string, filename: string): Promise<boolean> {
  try {
    const row = getMediaRow(page, rowLabel);
    const fileWithName = row.locator(`text=${filename}`)
      .or(row.locator(`[title*="${filename}"]`))
      .or(row.locator(`[alt*="${filename}"]`));
    return await fileWithName.isVisible({ timeout: 2000 });
  } catch {
    return false;
  }
}

/**
 * Waits for the media section to re-render after modal closes
 * Detects when the listing media section has updated with new content
 */
export async function waitForMediaSectionUpdate(
  page: Page,
  rowLabel: string,
  baselineCount: number,
  timeout: number = TIMEOUTS.MEDIA_SECTION_RERENDER
): Promise<{ updated: boolean; newCount: number }> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const currentCount = await getMediaRowCount(page, rowLabel);

    if (currentCount > baselineCount) {
      return { updated: true, newCount: currentCount };
    }

    await page.waitForTimeout(TIMEOUTS.STATE_POLL_INTERVAL);
  }

  const finalCount = await getMediaRowCount(page, rowLabel);
  return { updated: finalCount > baselineCount, newCount: finalCount };
}

/**
 * Checks if a modal is currently open
 */
export async function isModalOpen(page: Page): Promise<boolean> {
  try {
    const modal = getUploadModal(page);
    return await modal.isVisible();
  } catch {
    return false;
  }
}

/**
 * Waits for any modal to close completely
 */
export async function waitForModalClose(page: Page, timeout: number = TIMEOUTS.MODAL_CLOSE): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const modalOpen = await isModalOpen(page);
    if (!modalOpen) {
      return true;
    }
    await page.waitForTimeout(TIMEOUTS.STATE_POLL_INTERVAL);
  }

  return false;
}

// ============================================================================
// CHECKBOX INTERACTION HELPERS
// ============================================================================

/**
 * Result of resolving and interacting with a checkbox
 */
export interface CheckboxInteractionResult {
  success: boolean;
  error?: string;
  method?: 'checkbox_check' | 'label_click' | 'force_check';
  isChecked?: boolean;
  modalHtml?: string | null; // HTML dump on failure
}

/**
 * Robustly finds and checks the "Set titles from filenames" checkbox.
 *
 * Steps:
 * 1. Find the label containing "Set titles from filenames"
 * 2. Resolve the checkbox input:
 *    - If label has for="X", locate #X and ensure it's input[type=checkbox]
 *    - Else find input[type=checkbox] within the label
 *    - Else search nearby container for matching checkbox
 * 3. Call checkbox.check({ force: true })
 * 4. Verify checkbox.isChecked() === true
 *
 * @param page - Playwright page
 * @returns CheckboxInteractionResult
 */
export async function findAndCheckSetTitlesCheckbox(page: Page): Promise<CheckboxInteractionResult> {
  let checkboxLocator: Locator | null = null;
  let resolveMethod = '';

  try {
    // Step 1: Find the label
    const labelLocator = page.locator('label').filter({ hasText: /set titles from filenames/i });
    const labelVisible = await labelLocator.isVisible({ timeout: TIMEOUTS.CHECKBOX_INTERACT }).catch(() => false);

    if (!labelVisible) {
      // Try role-based selector as fallback
      const roleCheckbox = page.getByRole('checkbox', { name: /set titles from filenames/i });
      if (await roleCheckbox.isVisible({ timeout: 2000 }).catch(() => false)) {
        checkboxLocator = roleCheckbox;
        resolveMethod = 'role_based';
      } else {
        return {
          success: false,
          error: 'Could not find "Set titles from filenames" label or checkbox',
          modalHtml: await dumpUploadModalHtml(page),
        };
      }
    } else {
      // Step 2: Resolve the checkbox from the label
      // Check if label has for="X" attribute
      const forAttr = await labelLocator.getAttribute('for');

      if (forAttr) {
        // Label points to an element by ID
        // Escape special characters in the ID for CSS selector (CSS.escape not available in Node.js)
        const escapedId = forAttr.replace(/([!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, '\\$1');
        const targetElement = page.locator(`#${escapedId}`);
        const tagName = await targetElement.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
        const inputType = await targetElement.getAttribute('type').catch(() => '');

        if (tagName === 'input' && inputType === 'checkbox') {
          checkboxLocator = targetElement;
          resolveMethod = 'label_for_attribute';
        } else {
          // The for attribute points to something that's not a checkbox
          // Look inside that element for a checkbox
          checkboxLocator = targetElement.locator('input[type="checkbox"]').first();
          resolveMethod = 'label_for_nested';
        }
      } else {
        // No for attribute - look for checkbox inside the label
        checkboxLocator = labelLocator.locator('input[type="checkbox"]').first();
        resolveMethod = 'label_nested';

        // If not found inside label, try sibling
        if (!await checkboxLocator.isVisible({ timeout: 1000 }).catch(() => false)) {
          // Try finding input as a sibling
          checkboxLocator = labelLocator.locator('xpath=preceding-sibling::input[@type="checkbox"] | following-sibling::input[@type="checkbox"]').first();
          resolveMethod = 'label_sibling';
        }
      }
    }

    // Verify we have a checkbox locator
    if (!checkboxLocator) {
      return {
        success: false,
        error: 'Could not resolve checkbox from label',
        modalHtml: await dumpUploadModalHtml(page),
      };
    }

    // Check if checkbox is visible
    const isVisible = await checkboxLocator.isVisible({ timeout: 2000 }).catch(() => false);
    if (!isVisible) {
      // Try clicking the label as fallback
      const label = page.locator('label').filter({ hasText: /set titles from filenames/i });
      try {
        await label.click({ force: true });
        // Verify by checking if any checkbox nearby is now checked
        await page.waitForTimeout(300);

        // Look for any checked checkbox near the label
        const nearbyChecked = label.locator('input[type="checkbox"]:checked')
          .or(label.locator('xpath=preceding-sibling::input[@type="checkbox"][@checked]'))
          .or(label.locator('xpath=following-sibling::input[@type="checkbox"][@checked]'));

        if (await nearbyChecked.isVisible({ timeout: 1000 }).catch(() => false)) {
          return {
            success: true,
            method: 'label_click',
            isChecked: true,
          };
        }

        // Still try to verify via role
        const roleCheck = page.getByRole('checkbox', { name: /set titles from filenames/i });
        if (await roleCheck.isChecked().catch(() => false)) {
          return {
            success: true,
            method: 'label_click',
            isChecked: true,
          };
        }

        return {
          success: false,
          error: 'Clicked label but could not verify checkbox state',
          modalHtml: await dumpUploadModalHtml(page),
        };
      } catch (labelErr) {
        return {
          success: false,
          error: `Checkbox not visible and label click failed: ${labelErr instanceof Error ? labelErr.message : String(labelErr)}`,
          modalHtml: await dumpUploadModalHtml(page),
        };
      }
    }

    // Step 3: Check the checkbox with force
    await checkboxLocator.check({ force: true });

    // Step 4: Verify isChecked === true
    const isChecked = await checkboxLocator.isChecked();
    if (!isChecked) {
      // Try one more time with click
      await checkboxLocator.click({ force: true });
      await page.waitForTimeout(200);

      const isCheckedRetry = await checkboxLocator.isChecked();
      if (!isCheckedRetry) {
        return {
          success: false,
          error: `Checkbox.check() succeeded but isChecked() returned false (resolve method: ${resolveMethod})`,
          isChecked: false,
          modalHtml: await dumpUploadModalHtml(page),
        };
      }
    }

    return {
      success: true,
      method: 'force_check',
      isChecked: true,
    };

  } catch (err) {
    return {
      success: false,
      error: `Exception during checkbox interaction: ${err instanceof Error ? err.message : String(err)}`,
      modalHtml: await dumpUploadModalHtml(page),
    };
  }
}
