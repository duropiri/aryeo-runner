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
 */
export function getAddFilesButton(page: Page): Locator {
  return page.locator('button.bg-primary').filter({ hasText: /Add \d+ Files?/i })
    .or(page.locator('button[variant="primary"]').filter({ hasText: /Add.*Files?/i }));
}

/**
 * Gets the Done button in the upload widget (after files are uploaded)
 */
export function getDoneButton(page: Page): Locator {
  return page.locator('button.uc-done-btn')
    .or(page.locator('button.uc-primary-btn').filter({ hasText: 'Done' }));
}

// ============================================================================
// 3D CONTENT MODAL LOCATORS
// ============================================================================

/**
 * Gets the 3D Content modal/dialog
 */
export function get3DContentModal(page: Page): Locator {
  return page.getByRole('dialog')
    .or(page.locator('[class*="modal"]').filter({ hasText: /3D|content|tour/i }));
}

/**
 * Gets the Content Title input in 3D Content modal
 * Structure: <input id="ContentTitle:" placeholder="Title">
 */
export function getContentTitleInput(page: Page): Locator {
  return page.locator('input#ContentTitle\\:')
    .or(page.locator('input[id="ContentTitle:"]'))
    .or(page.getByPlaceholder('Title'));
}

/**
 * Gets the Content Link input in 3D Content modal
 * Structure: <input id="Pasteyourlinkbelow:" placeholder="Content Link">
 */
export function getContentLinkInput(page: Page): Locator {
  return page.locator('input#Pasteyourlinkbelow\\:')
    .or(page.locator('input[id="Pasteyourlinkbelow:"]'))
    .or(page.getByPlaceholder('Content Link'));
}

/**
 * Gets the Display Type dropdown/select in 3D Content modal
 * Structure: <select id="DisplayType">
 */
export function getDisplayTypeDropdown(page: Page): Locator {
  return page.locator('select#DisplayType')
    .or(page.locator('select[id="DisplayType"]'))
    .or(page.getByRole('combobox', { name: /display type/i }));
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
 * Checks if 3D content with a specific title already exists
 */
export function get3DContentItemByTitle(page: Page, title: string): Locator {
  return page.locator('[class*="content-item"], [class*="media-item"], li, div')
    .filter({ hasText: title });
}

/**
 * Gets all existing 3D content items
 */
export function getExisting3DContentItems(page: Page): Locator {
  const row = getMediaRow(page, TEXT.THREE_D_CONTENT);
  return row.locator('[class*="item"], [class*="content"]');
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
