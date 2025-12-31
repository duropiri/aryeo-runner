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
  // URL staging (file download/processing) - can be slow for large files
  URL_STAGING: 90000,
  // Wait for commit button to be enabled after staging complete
  COMMIT_BUTTON_ENABLED: 30000,
  // Modal close after commit
  MODAL_CLOSE: 45000,
  // Post-condition verification (count changed, item appeared)
  POST_VERIFY: 45000,
  // Default element visibility
  ELEMENT_VISIBLE: 10000,
  // State polling interval (how often to check UI state)
  STATE_POLL_INTERVAL: 250,
  // Maximum time to wait for upload progress to complete
  UPLOAD_PROGRESS_COMPLETE: 120000,
  // Time to wait for media section re-render after modal closes
  MEDIA_SECTION_RERENDER: 10000,
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
 * Structure: <label id="set_titles"><input name="set_titles">...<div>Set titles from filenames</div></label>
 */
export function getSetTitlesCheckbox(page: Page): Locator {
  return page.locator('label#set_titles')
    .or(page.locator('label').filter({ hasText: 'Set titles from filenames' }));
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
 * Upload state for deterministic automation
 */
export interface UploadUIState {
  hasProgressBar: boolean;
  progressPercent: number | null;
  hasSkeletonLoader: boolean;
  hasSpinnerInModal: boolean;
  hasStagedFile: boolean;
  hasRealFilename: boolean;
  isAddFilesButtonEnabled: boolean;
  isAddFilesButtonVisible: boolean;
  hasErrorMessage: boolean;
  errorMessage: string | null;
}

/**
 * Gets the upload progress bar element in the Uploadcare widget
 * Progress is shown as a bar during file download/processing
 */
export function getUploadProgressBar(page: Page): Locator {
  return page.locator('uc-progress-bar, [class*="uc-progress"], [class*="progress-bar"], [role="progressbar"]')
    .or(page.locator('.uc-file-item [class*="progress"]'))
    .or(page.locator('uc-file-item [class*="uploading"]'));
}

/**
 * Gets skeleton/placeholder loaders in the upload widget
 * These appear when a file is being processed but not yet ready
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
 * Gets file items that have completed staging (have real filenames, not placeholders)
 * A staged file should show actual filename text, thumbnail, or completion indicator
 */
export function getCompletedStagedFile(page: Page): Locator {
  // Files that have completed staging have a done state or show file info
  return page.locator('uc-file-item[data-state="idle"], uc-file-item[data-state="done"]')
    .or(page.locator('.uc-file-item--done, .uc-file-item--idle'))
    .or(page.locator('uc-file-item:not([data-state="uploading"]):not([data-state="processing"])'));
}

/**
 * Gets the filename text element within a staged file item
 */
export function getStagedFileName(page: Page): Locator {
  return page.locator('uc-file-item .uc-file-name, uc-file-item [class*="file-name"]')
    .or(page.locator('.uc-file-item__name'))
    .or(page.locator('uc-upload-list [class*="filename"]'));
}

/**
 * Gets the thumbnail/preview image for a staged file
 */
export function getStagedFileThumbnail(page: Page): Locator {
  return page.locator('uc-file-item img, uc-file-item [class*="thumb"], uc-file-item [class*="preview"]')
    .or(page.locator('.uc-file-item__thumb, .uc-file-item__preview'));
}

/**
 * Comprehensive function to capture the current upload UI state
 * This is the key function for state-driven automation
 */
export async function getUploadUIState(page: Page): Promise<UploadUIState> {
  const state: UploadUIState = {
    hasProgressBar: false,
    progressPercent: null,
    hasSkeletonLoader: false,
    hasSpinnerInModal: false,
    hasStagedFile: false,
    hasRealFilename: false,
    isAddFilesButtonEnabled: false,
    isAddFilesButtonVisible: false,
    hasErrorMessage: false,
    errorMessage: null,
  };

  try {
    // Check for progress bar
    const progressBar = getUploadProgressBar(page);
    state.hasProgressBar = await progressBar.isVisible().catch(() => false);

    if (state.hasProgressBar) {
      // Try to extract progress percentage
      try {
        const progressValue = await progressBar.getAttribute('aria-valuenow');
        if (progressValue) {
          state.progressPercent = parseInt(progressValue, 10);
        } else {
          // Try style width for CSS-based progress bars
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

    // Check for skeleton loaders
    const skeleton = getSkeletonLoader(page);
    state.hasSkeletonLoader = await skeleton.isVisible().catch(() => false);

    // Check for spinners in modal
    const spinner = getUploadModalSpinner(page);
    state.hasSpinnerInModal = await spinner.isVisible().catch(() => false);

    // Check for staged file preview
    const stagedPreview = getStagedFilePreview(page);
    state.hasStagedFile = await stagedPreview.isVisible().catch(() => false);

    // Check if staged file has a real filename (not placeholder)
    if (state.hasStagedFile) {
      const filename = getStagedFileName(page);
      const thumbnail = getStagedFileThumbnail(page);
      const completedFile = getCompletedStagedFile(page);

      const hasFilename = await filename.isVisible().catch(() => false);
      const hasThumbnail = await thumbnail.isVisible().catch(() => false);
      const isCompleted = await completedFile.isVisible().catch(() => false);

      state.hasRealFilename = hasFilename || hasThumbnail || isCompleted;
    }

    // Check Add Files button state
    const addFilesButton = getCommitFilesButton(page);
    state.isAddFilesButtonVisible = await addFilesButton.isVisible().catch(() => false);

    if (state.isAddFilesButtonVisible) {
      const isDisabled = await addFilesButton.isDisabled().catch(() => true);
      state.isAddFilesButtonEnabled = !isDisabled;
    }

    // Check for error messages
    const errorToast = getErrorToast(page);
    state.hasErrorMessage = await errorToast.isVisible().catch(() => false);

    if (state.hasErrorMessage) {
      state.errorMessage = await errorToast.textContent().catch(() => null);
    }

  } catch {
    // Return partial state on error
  }

  return state;
}

/**
 * Determines if the upload is still in progress based on UI state
 */
export function isUploadInProgress(state: UploadUIState): boolean {
  // Upload is in progress if:
  // - Progress bar is visible AND not at 100%
  // - Skeleton loaders are visible
  // - Spinner is visible in modal
  // - Add Files button is visible but disabled (processing)

  if (state.hasProgressBar && (state.progressPercent === null || state.progressPercent < 100)) {
    return true;
  }

  if (state.hasSkeletonLoader) {
    return true;
  }

  if (state.hasSpinnerInModal) {
    return true;
  }

  // If staged file exists but no real filename yet, still processing
  if (state.hasStagedFile && !state.hasRealFilename) {
    return true;
  }

  // If button is visible but disabled, still processing
  if (state.isAddFilesButtonVisible && !state.isAddFilesButtonEnabled) {
    return true;
  }

  return false;
}

/**
 * Determines if the UI is ready for the "Add Files" action
 */
export function isUIReadyForCommit(state: UploadUIState): boolean {
  // UI is ready when:
  // - No progress bar OR progress at 100%
  // - No skeleton loaders
  // - No spinner in modal
  // - Staged file has real filename OR thumbnail
  // - Add Files button is visible AND enabled
  // - No error message

  if (state.hasErrorMessage) {
    return false;
  }

  if (state.hasProgressBar && state.progressPercent !== null && state.progressPercent < 100) {
    return false;
  }

  if (state.hasSkeletonLoader) {
    return false;
  }

  if (state.hasSpinnerInModal) {
    return false;
  }

  if (state.hasStagedFile && !state.hasRealFilename) {
    return false;
  }

  return state.isAddFilesButtonVisible && state.isAddFilesButtonEnabled;
}

/**
 * Waits for the upload to complete and UI to be ready for commit
 * This is the state-machine approach - no blind delays
 * @returns Object with ready status and final state
 */
export async function waitForUploadReadyState(
  page: Page,
  timeout: number = TIMEOUTS.UPLOAD_PROGRESS_COMPLETE
): Promise<{ ready: boolean; state: UploadUIState; reason: string }> {
  const startTime = Date.now();
  let lastState: UploadUIState = await getUploadUIState(page);
  let stableCount = 0;
  const requiredStableChecks = 3; // Must be stable for 3 consecutive checks

  while (Date.now() - startTime < timeout) {
    const currentState = await getUploadUIState(page);

    // Check for error state first
    if (currentState.hasErrorMessage) {
      return {
        ready: false,
        state: currentState,
        reason: `Upload error: ${currentState.errorMessage || 'Unknown error'}`,
      };
    }

    // Check if ready for commit
    if (isUIReadyForCommit(currentState)) {
      stableCount++;
      if (stableCount >= requiredStableChecks) {
        return {
          ready: true,
          state: currentState,
          reason: 'Upload complete and UI ready for commit',
        };
      }
    } else {
      stableCount = 0; // Reset stability counter if state changes
    }

    // Log progress for debugging
    if (currentState.hasProgressBar && currentState.progressPercent !== null) {
      // Progress is being made
    }

    lastState = currentState;
    await page.waitForTimeout(TIMEOUTS.STATE_POLL_INTERVAL);
  }

  // Timeout - determine why
  if (isUploadInProgress(lastState)) {
    return {
      ready: false,
      state: lastState,
      reason: 'Timeout: upload still in progress',
    };
  }

  if (!lastState.hasStagedFile) {
    return {
      ready: false,
      state: lastState,
      reason: 'Timeout: no staged file appeared',
    };
  }

  if (!lastState.isAddFilesButtonVisible) {
    return {
      ready: false,
      state: lastState,
      reason: 'Timeout: Add Files button not visible',
    };
  }

  if (!lastState.isAddFilesButtonEnabled) {
    return {
      ready: false,
      state: lastState,
      reason: 'Timeout: Add Files button not enabled',
    };
  }

  return {
    ready: false,
    state: lastState,
    reason: 'Timeout: unknown state issue',
  };
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
