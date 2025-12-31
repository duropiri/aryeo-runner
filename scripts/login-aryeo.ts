#!/usr/bin/env tsx

/**
 * Interactive Aryeo Login Script
 *
 * This script opens a browser window for you to manually log in to Aryeo.
 * After successful login, it saves the session state to be used by the worker.
 *
 * Usage:
 *   npm run login
 *   # or
 *   npx tsx scripts/login-aryeo.ts
 *
 * The script will:
 * 1. Open a browser window to Aryeo login page
 * 2. Wait for you to complete login (including 2FA if required)
 * 3. Detect successful login
 * 4. Save the session state to ./data/auth/aryeo-storage-state.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ARYEO_LOGIN_URL = 'https://app.aryeo.com/login';
const ARYEO_DASHBOARD_URL = 'https://app.aryeo.com';

// Default data directory
const DATA_DIR = process.env.DATA_DIR ?? './data';
const STORAGE_STATE_PATH = path.join(DATA_DIR, 'auth', 'aryeo-storage-state.json');

// Timeout for waiting for login (5 minutes)
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Checks if the user is logged in by looking for dashboard elements
 */
async function isLoggedIn(page: import('playwright').Page): Promise<boolean> {
  try {
    // Check for common logged-in indicators
    const indicators = [
      '[data-testid="user-menu"]',
      '.user-menu',
      '.avatar-dropdown',
      'nav:has-text("Dashboard")',
      'nav:has-text("Listings")',
      'a[href*="/listings"]',
    ];

    for (const selector of indicators) {
      try {
        const element = page.locator(selector).first();
        if (await element.isVisible({ timeout: 1000 })) {
          return true;
        }
      } catch {
        // Continue checking
      }
    }

    // Also check if URL indicates logged in state
    const url = page.url();
    if (url.includes('/admin') || url.includes('/dashboard') || url.includes('/listings')) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Safe page stabilization that doesn't hang on SPA background network activity.
 * Avoids networkidle which can timeout on SPAs with persistent connections.
 */
async function waitForPageStable(page: import('playwright').Page): Promise<void> {
  // Try to wait for dashboard-like URL (ignore failures)
  try {
    await page.waitForURL(/\/(admin|dashboard|listings|projects|orders)/, { timeout: 120000 });
  } catch {
    // URL pattern not matched, continue anyway
  }

  // Wait for DOM to be ready (ignore failures)
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 60000 });
  } catch {
    // DOM not ready in time, continue anyway
  }

  // Brief pause to let any final renders complete
  await page.waitForTimeout(1500);
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         Aryeo Login - Session State Generator              ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('This script will open a browser window for you to log in to Aryeo.');
  console.log('After successful login, your session will be saved for automation.');
  console.log('');

  // Ensure storage directory exists
  const authDir = path.dirname(STORAGE_STATE_PATH);
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
    console.log(`Created directory: ${authDir}`);
  }

  // Launch browser in non-headless mode for interactive login
  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: false,
    slowMo: 50, // Slow down for better visibility
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  console.log('');
  console.log('Opening Aryeo login page...');
  console.log(`URL: ${ARYEO_LOGIN_URL}`);
  console.log('');

  // Navigate and wait for DOM (avoid networkidle which can hang on SPAs)
  await page.goto(ARYEO_LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  Please log in to Aryeo in the browser window.             ║');
  console.log('║  Complete any 2FA or security checks if prompted.          ║');
  console.log('║                                                            ║');
  console.log('║  The script will automatically detect when you\'re logged   ║');
  console.log('║  in and save your session.                                 ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  // Poll for logged-in state
  const startTime = Date.now();
  let loggedIn = false;

  while (!loggedIn && Date.now() - startTime < LOGIN_TIMEOUT_MS) {
    loggedIn = await isLoggedIn(page);

    if (!loggedIn) {
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Check every 2 seconds
      process.stdout.write('.');
    }
  }

  console.log('');

  if (!loggedIn) {
    console.error('');
    console.error('❌ Login timeout - could not detect successful login within 5 minutes.');
    console.error('');
    console.error('Possible reasons:');
    console.error('  - Login was not completed');
    console.error('  - Aryeo UI has changed and login detection needs updating');
    console.error('');
    await browser.close();
    process.exit(1);
  }

  console.log('');
  console.log('✓ Login detected! Saving session state...');

  // Wait for page to stabilize (safe sequence that won't hang on SPA)
  await waitForPageStable(page);

  // Save storage state immediately after login is confirmed
  await context.storageState({ path: STORAGE_STATE_PATH });

  // Verify file was written successfully
  const fileStats = fs.statSync(STORAGE_STATE_PATH);
  if (fileStats.size === 0) {
    console.error('❌ Error: Session state file is empty!');
    await browser.close();
    process.exit(1);
  }

  console.log(`✓ Session state saved to: ${STORAGE_STATE_PATH}`);
  console.log(`✓ File size: ${fileStats.size} bytes`);
  console.log('');

  // Show session info
  const storageState = JSON.parse(fs.readFileSync(STORAGE_STATE_PATH, 'utf-8'));
  const cookieCount = storageState.cookies?.length ?? 0;
  const originCount = storageState.origins?.length ?? 0;

  console.log('Session details:');
  console.log(`  - Cookies saved: ${cookieCount}`);
  console.log(`  - Origins saved: ${originCount}`);
  console.log(`  - Current URL: ${page.url()}`);
  console.log('');

  await browser.close();

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║                    Setup Complete!                          ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('You can now run the delivery worker. It will use the saved');
  console.log('session to authenticate with Aryeo automatically.');
  console.log('');
  console.log('Note: If your session expires, re-run this script to refresh it.');
  console.log('');
}

main().catch((err) => {
  console.error('');
  console.error('❌ Error during login process:');
  console.error(err);
  process.exit(1);
});
