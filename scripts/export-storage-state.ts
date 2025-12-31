#!/usr/bin/env tsx

/**
 * Export Aryeo Storage State CLI
 *
 * Performs non-Playwright HTTP-based login to Aryeo and exports the session
 * as a Playwright-compatible storage state JSON file.
 *
 * Usage:
 *   npm run export:storage-state
 *   # or with dry-run
 *   npm run export:storage-state -- --dry-run
 *
 * Environment Variables:
 *   ARYEO_EMAIL     - Aryeo account email (required)
 *   ARYEO_PASSWORD  - Aryeo account password (required)
 *   DATA_DIR        - Data directory (default: ./data)
 *   RUNNER_BASE_URL - Remote runner URL for push (optional)
 *   RUNNER_AUTH_TOKEN - Runner auth token for push (optional)
 *
 * Options:
 *   --dry-run    Print summary without writing files
 *   --push       Push to remote runner (requires RUNNER_BASE_URL and RUNNER_AUTH_TOKEN)
 *   --verify     Verify session after export
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fetch } from 'undici';
import { loginToAryeo, verifySession, getAryeoCookies } from '../src/aryeoHttpLogin.js';
import {
  cookieJarToStorageState,
  validateAryeoCookies,
  getStorageStateSummary,
  type PlaywrightStorageState,
} from '../src/playwrightStorageState.js';

// =============================================================================
// Configuration
// =============================================================================

const DATA_DIR = process.env.DATA_DIR ?? './data';
const STORAGE_STATE_PATH = path.join(DATA_DIR, 'auth', 'aryeo-storage-state.json');

const RUNNER_BASE_URL = process.env.RUNNER_BASE_URL;
const RUNNER_AUTH_TOKEN = process.env.RUNNER_AUTH_TOKEN;

// =============================================================================
// CLI Argument Parsing
// =============================================================================

interface CliOptions {
  dryRun: boolean;
  push: boolean;
  verify: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    push: args.includes('--push'),
    verify: args.includes('--verify'),
  };
}

// =============================================================================
// Atomic File Write
// =============================================================================

async function writeAtomically(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write to temp file first
  const tempPath = path.join(os.tmpdir(), `aryeo-storage-state-${Date.now()}.json`);

  try {
    fs.writeFileSync(tempPath, content, 'utf-8');

    // Verify temp file is valid JSON
    JSON.parse(fs.readFileSync(tempPath, 'utf-8'));

    // Atomic rename
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    // Clean up temp file if it exists
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

// =============================================================================
// Push to Remote Runner
// =============================================================================

async function pushToRunner(storageState: PlaywrightStorageState): Promise<boolean> {
  if (!RUNNER_BASE_URL || !RUNNER_AUTH_TOKEN) {
    console.error('Cannot push: RUNNER_BASE_URL and RUNNER_AUTH_TOKEN are required');
    return false;
  }

  const url = `${RUNNER_BASE_URL.replace(/\/$/, '')}/auth/storage-state`;

  try {
    console.log(`Pushing to ${url}...`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RUNNER_AUTH_TOKEN}`,
      },
      body: JSON.stringify(storageState),
    });

    if (response.ok) {
      console.log('Pushed successfully!');
      return true;
    } else {
      const text = await response.text();
      console.error(`Push failed: HTTP ${response.status} - ${text}`);
      return false;
    }
  } catch (err) {
    console.error(`Push failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// =============================================================================
// Print Summary
// =============================================================================

function printSummary(state: PlaywrightStorageState): void {
  const summary = getStorageStateSummary(state);
  const validation = validateAryeoCookies(state.cookies);

  console.log('');
  console.log('=== Storage State Summary ===');
  console.log(`Cookie count: ${summary.cookieCount}`);
  console.log(`Origin count: ${summary.originCount}`);
  console.log(`Domains: ${summary.domains.join(', ')}`);
  console.log(`Session cookies: ${summary.sessionCookieCount}`);

  if (summary.soonestExpiry) {
    console.log(`Soonest expiry: ${summary.soonestExpiry.toISOString()}`);
    const hoursUntilExpiry = (summary.soonestExpiry.getTime() - Date.now()) / (1000 * 60 * 60);
    console.log(`  (${hoursUntilExpiry.toFixed(1)} hours from now)`);
  } else {
    console.log('Soonest expiry: N/A (all session cookies)');
  }

  console.log('');
  console.log('=== Expected Cookies ===');
  console.log(`XSRF-TOKEN: ${summary.expectedCookies.xsrfToken ? 'present' : 'MISSING'}`);
  console.log(`aryeo_session: ${summary.expectedCookies.aryeoSession ? 'present' : 'MISSING'}`);

  if (validation.warnings.length > 0) {
    console.log('');
    console.log('=== Warnings ===');
    for (const warning of validation.warnings) {
      console.log(`  - ${warning}`);
    }
  }

  if (validation.errors.length > 0) {
    console.log('');
    console.log('=== ERRORS ===');
    for (const error of validation.errors) {
      console.error(`  - ${error}`);
    }
  }

  console.log('');
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const options = parseArgs();

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║       Aryeo Storage State Exporter (Non-Playwright)        ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  if (options.dryRun) {
    console.log('Mode: DRY RUN (no files will be written)');
    console.log('');
  }

  // Validate environment variables
  const email = process.env.ARYEO_EMAIL;
  const password = process.env.ARYEO_PASSWORD;

  if (!email || !password) {
    console.error('ERROR: ARYEO_EMAIL and ARYEO_PASSWORD environment variables are required');
    console.error('');
    console.error('Set them in your environment or .env file:');
    console.error('  export ARYEO_EMAIL="your-email@example.com"');
    console.error('  export ARYEO_PASSWORD="your-password"');
    console.error('');
    console.error('NEVER hardcode credentials in source files!');
    process.exit(1);
  }

  // Mask email in logs
  const maskedEmail = email.replace(/(.{2})(.*)(@.*)/, '$1***$3');
  console.log(`Logging in as: ${maskedEmail}`);
  console.log('');

  // Perform login
  const loginResult = await loginToAryeo(email, password);

  if (!loginResult.success) {
    console.error('');
    console.error('LOGIN FAILED');
    console.error(`Error: ${loginResult.error}`);
    console.error('');
    console.error('Troubleshooting:');
    console.error('  1. Verify email and password are correct');
    console.error('  2. Check if Aryeo requires 2FA (not supported in HTTP login)');
    console.error('  3. Try the Playwright-based login: npm run login');
    console.error('  4. Check if Aryeo login page has changed');
    process.exit(1);
  }

  console.log(`Logged in successfully! Redirect URL: ${loginResult.redirectUrl}`);

  // Verify session if requested
  if (options.verify) {
    console.log('');
    console.log('Verifying session...');
    const verification = await verifySession(loginResult.cookieJar);

    if (!verification.valid) {
      console.error(`Session verification failed: ${verification.error}`);
      process.exit(1);
    }

    console.log(`Session verified! URL: ${verification.url}`);
  }

  // Convert to Playwright storage state
  const storageState = cookieJarToStorageState(loginResult.cookieJar);
  const validation = validateAryeoCookies(storageState.cookies);

  // Print summary
  printSummary(storageState);

  // Check for critical errors
  if (!validation.valid) {
    console.error('');
    console.error('Storage state validation failed - missing critical cookies.');
    console.error('The exported session may not work correctly.');
    console.error('');
    console.error('This can happen if:');
    console.error('  1. Aryeo has changed their cookie structure');
    console.error('  2. Login was not fully completed');
    console.error('  3. Account has restrictions');
    console.error('');
    console.error('Consider using the Playwright-based login instead: npm run login');
    process.exit(1);
  }

  // Serialize to JSON
  const jsonContent = JSON.stringify(storageState, null, 2);
  console.log(`JSON size: ${jsonContent.length} bytes`);

  // Dry run - just print and exit
  if (options.dryRun) {
    console.log('');
    console.log('=== DRY RUN - Would write to: ===');
    console.log(STORAGE_STATE_PATH);
    console.log('');
    console.log('=== JSON Preview (first 500 chars) ===');
    console.log(jsonContent.substring(0, 500));
    if (jsonContent.length > 500) {
      console.log('...');
    }
    console.log('');
    console.log('Dry run complete. No files written.');
    return;
  }

  // Write storage state atomically
  console.log('');
  console.log(`Writing to: ${STORAGE_STATE_PATH}`);

  try {
    await writeAtomically(STORAGE_STATE_PATH, jsonContent);

    // Verify file was written
    const stats = fs.statSync(STORAGE_STATE_PATH);
    console.log(`File written successfully (${stats.size} bytes)`);
  } catch (err) {
    console.error(`Failed to write file: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Push to remote runner if requested
  if (options.push) {
    console.log('');
    if (!RUNNER_BASE_URL || !RUNNER_AUTH_TOKEN) {
      console.error('Cannot push: Set RUNNER_BASE_URL and RUNNER_AUTH_TOKEN environment variables');
    } else {
      const pushed = await pushToRunner(storageState);
      if (!pushed) {
        console.error('Push failed - file was written locally');
        process.exit(1);
      }
    }
  }

  // Success!
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║                    Export Complete!                         ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Next steps:');
  console.log(`  1. Copy to server: scp ${STORAGE_STATE_PATH} user@server:/opt/aryeo-runner/data/auth/`);
  console.log('  2. Or use --push flag to push via API (requires RUNNER_BASE_URL + RUNNER_AUTH_TOKEN)');
  console.log('');
  console.log('Note: If session expires, re-run this script to refresh.');
  if (validation.warnings.length > 0) {
    console.log('');
    console.log(`Warning: ${validation.warnings.length} warning(s) detected - check summary above.`);
  }
}

main().catch((err) => {
  console.error('');
  console.error('Unexpected error:');
  console.error(err);
  process.exit(1);
});
