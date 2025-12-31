/**
 * Playwright Storage State Converter
 *
 * Converts tough-cookie CookieJar cookies to Playwright-compatible
 * storage state format for use with browser.newContext({ storageState }).
 *
 * Playwright storage state shape:
 * {
 *   cookies: Array<{
 *     name: string;
 *     value: string;
 *     domain: string;
 *     path: string;
 *     expires: number;  // Unix timestamp in seconds, -1 for session cookies
 *     httpOnly: boolean;
 *     secure: boolean;
 *     sameSite: "Strict" | "Lax" | "None";
 *   }>;
 *   origins: Array<{
 *     origin: string;
 *     localStorage: Array<{ name: string; value: string }>;
 *   }>;
 * }
 */

import { CookieJar, Cookie } from 'tough-cookie';

/**
 * Playwright cookie format.
 */
export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

/**
 * Playwright origin storage (localStorage/sessionStorage).
 */
export interface PlaywrightOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

/**
 * Complete Playwright storage state format.
 */
export interface PlaywrightStorageState {
  cookies: PlaywrightCookie[];
  origins: PlaywrightOrigin[];
}

/**
 * Cookie metadata validation result.
 */
export interface CookieValidation {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

/**
 * Convert tough-cookie sameSite to Playwright sameSite.
 *
 * tough-cookie uses: 'strict' | 'lax' | 'none' | undefined
 * Playwright uses: 'Strict' | 'Lax' | 'None'
 */
function convertSameSite(sameSite: string | undefined): 'Strict' | 'Lax' | 'None' {
  if (!sameSite) {
    // Default to Lax for security (most common for session cookies)
    return 'Lax';
  }

  const lower = sameSite.toLowerCase();
  switch (lower) {
    case 'strict':
      return 'Strict';
    case 'lax':
      return 'Lax';
    case 'none':
      return 'None';
    default:
      // Conservative default
      return 'Lax';
  }
}

/**
 * Convert tough-cookie expires to Playwright expires (Unix seconds).
 *
 * - Session cookies (no expires): use -1
 * - Expired cookies: skip them
 * - Future expires: convert to Unix seconds
 */
function convertExpires(expires: Date | 'Infinity' | null | undefined): number {
  if (!expires || expires === 'Infinity') {
    // Session cookie - Playwright uses -1 for session cookies
    return -1;
  }

  if (expires instanceof Date) {
    const unixSeconds = Math.floor(expires.getTime() / 1000);
    return unixSeconds;
  }

  // Unknown format, treat as session
  return -1;
}

/**
 * Check if a cookie is expired.
 */
function isExpired(expires: Date | 'Infinity' | null | undefined): boolean {
  if (!expires || expires === 'Infinity') {
    return false; // Session cookies don't expire by time
  }

  if (expires instanceof Date) {
    return expires.getTime() < Date.now();
  }

  return false;
}

/**
 * Convert a single tough-cookie Cookie to Playwright format.
 *
 * @param cookie - tough-cookie Cookie object
 * @returns Playwright cookie or null if cookie is invalid/expired
 */
export function convertCookieToPlaywright(cookie: Cookie): PlaywrightCookie | null {
  // Skip expired cookies
  if (isExpired(cookie.expires)) {
    return null;
  }

  // Validate required fields
  if (!cookie.key || cookie.value === undefined) {
    return null;
  }

  // Domain handling:
  // - tough-cookie stores domain with leading dot for domain cookies
  // - Playwright expects the same format
  let domain = cookie.domain || '';

  // Ensure domain has leading dot for domain-wide cookies (Playwright expects this)
  // But if it's a host-only cookie, keep it as-is
  if (domain && !domain.startsWith('.') && cookie.hostOnly !== true) {
    domain = '.' + domain;
  }

  return {
    name: cookie.key,
    value: cookie.value,
    domain: domain,
    path: cookie.path || '/',
    expires: convertExpires(cookie.expires),
    httpOnly: cookie.httpOnly || false,
    secure: cookie.secure || false,
    sameSite: convertSameSite(cookie.sameSite),
  };
}

/**
 * Convert an array of tough-cookie Cookies to Playwright format.
 *
 * @param cookies - Array of tough-cookie Cookie objects
 * @returns Array of Playwright cookies (expired/invalid cookies filtered out)
 */
export function convertCookiesToPlaywright(cookies: Cookie[]): PlaywrightCookie[] {
  const playwrightCookies: PlaywrightCookie[] = [];

  for (const cookie of cookies) {
    const converted = convertCookieToPlaywright(cookie);
    if (converted) {
      playwrightCookies.push(converted);
    }
  }

  return playwrightCookies;
}

/**
 * Convert a tough-cookie CookieJar to Playwright storage state.
 *
 * This extracts all cookies from the jar and converts them to the format
 * expected by Playwright's context.storageState().
 *
 * @param cookieJar - tough-cookie CookieJar
 * @param origins - Optional array of origins to include localStorage for
 * @returns Complete Playwright storage state object
 */
export function cookieJarToStorageState(
  cookieJar: CookieJar,
  origins: string[] = ['https://app.aryeo.com']
): PlaywrightStorageState {
  // Get all cookies from the jar
  // We need to serialize and deserialize to get all cookies regardless of URL
  const jarData = cookieJar.serializeSync();
  const cookies: Cookie[] = [];

  if (jarData && jarData.cookies) {
    for (const cookieData of jarData.cookies) {
      const cookie = Cookie.fromJSON(cookieData);
      if (cookie) {
        cookies.push(cookie);
      }
    }
  }

  const playwrightCookies = convertCookiesToPlaywright(cookies);

  // Create origin entries (with empty localStorage - we don't capture that via HTTP)
  const originEntries: PlaywrightOrigin[] = origins.map((origin) => ({
    origin,
    localStorage: [],
  }));

  return {
    cookies: playwrightCookies,
    origins: originEntries,
  };
}

/**
 * Validate that cookies contain expected Aryeo session data.
 *
 * @param cookies - Array of Playwright cookies to validate
 * @returns Validation result with any warnings/errors
 */
export function validateAryeoCookies(cookies: PlaywrightCookie[]): CookieValidation {
  const warnings: string[] = [];
  const errors: string[] = [];

  // Check for required cookies
  const hasXsrfToken = cookies.some((c) => c.name === 'XSRF-TOKEN');
  const hasAryeoSession = cookies.some((c) => c.name === 'aryeo_session');

  if (!hasXsrfToken) {
    warnings.push('Missing XSRF-TOKEN cookie - CSRF protection may fail');
  }

  if (!hasAryeoSession) {
    errors.push('Missing aryeo_session cookie - session will not be authenticated');
  }

  // Check cookie domains
  const aryeoCookies = cookies.filter(
    (c) => c.domain.includes('aryeo.com') || c.domain === 'aryeo.com'
  );

  if (aryeoCookies.length === 0) {
    errors.push('No cookies for aryeo.com domain found');
  }

  // Check for soon-expiring cookies
  const now = Math.floor(Date.now() / 1000);
  const oneHour = 60 * 60;
  const oneDay = 24 * oneHour;

  for (const cookie of cookies) {
    if (cookie.expires > 0) {
      const timeLeft = cookie.expires - now;
      if (timeLeft < 0) {
        warnings.push(`Cookie ${cookie.name} is already expired`);
      } else if (timeLeft < oneHour) {
        warnings.push(`Cookie ${cookie.name} expires in less than 1 hour`);
      } else if (timeLeft < oneDay) {
        warnings.push(`Cookie ${cookie.name} expires in less than 24 hours`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}

/**
 * Get summary information about the storage state.
 */
export interface StorageStateSummary {
  cookieCount: number;
  originCount: number;
  domains: string[];
  soonestExpiry: Date | null;
  sessionCookieCount: number;
  expectedCookies: {
    xsrfToken: boolean;
    aryeoSession: boolean;
  };
}

/**
 * Generate a summary of the storage state for logging/display.
 *
 * @param state - Playwright storage state
 * @returns Summary object with stats and validation info
 */
export function getStorageStateSummary(state: PlaywrightStorageState): StorageStateSummary {
  const domains = [...new Set(state.cookies.map((c) => c.domain))];

  let soonestExpiry: Date | null = null;
  let sessionCookieCount = 0;

  for (const cookie of state.cookies) {
    if (cookie.expires === -1) {
      sessionCookieCount++;
    } else if (cookie.expires > 0) {
      const expiryDate = new Date(cookie.expires * 1000);
      if (!soonestExpiry || expiryDate < soonestExpiry) {
        soonestExpiry = expiryDate;
      }
    }
  }

  return {
    cookieCount: state.cookies.length,
    originCount: state.origins.length,
    domains,
    soonestExpiry,
    sessionCookieCount,
    expectedCookies: {
      xsrfToken: state.cookies.some((c) => c.name === 'XSRF-TOKEN'),
      aryeoSession: state.cookies.some((c) => c.name === 'aryeo_session'),
    },
  };
}

/**
 * Parse Set-Cookie headers directly to Playwright format.
 *
 * Use this when tough-cookie jar is not available but you have raw
 * Set-Cookie header values.
 *
 * @param setCookieHeaders - Array of Set-Cookie header values
 * @param defaultDomain - Default domain if not specified in cookie
 * @returns Array of Playwright cookies
 */
export function parseSetCookieHeaders(
  setCookieHeaders: string[],
  defaultDomain: string = 'app.aryeo.com'
): PlaywrightCookie[] {
  const cookies: PlaywrightCookie[] = [];

  for (const header of setCookieHeaders) {
    try {
      const parsed = Cookie.parse(header);
      if (parsed) {
        // If no domain specified, use the default
        if (!parsed.domain) {
          parsed.domain = defaultDomain;
        }
        const converted = convertCookieToPlaywright(parsed);
        if (converted) {
          cookies.push(converted);
        }
      }
    } catch {
      console.warn(`Failed to parse Set-Cookie header: ${header.substring(0, 50)}...`);
    }
  }

  return cookies;
}

/**
 * Create a minimal storage state from a cookie header string.
 *
 * WARNING: This loses metadata (expires, httpOnly, secure, sameSite).
 * Only use as a last resort when cookie jar is unavailable.
 *
 * @param cookieHeader - Cookie header value (e.g., "name1=value1; name2=value2")
 * @param domain - Domain to use for all cookies
 * @returns Playwright storage state with limited cookie metadata
 */
export function createStorageStateFromCookieHeader(
  cookieHeader: string,
  domain: string = '.aryeo.com'
): PlaywrightStorageState {
  console.warn(
    'WARNING: Creating storage state from cookie header loses metadata (expires, httpOnly, secure, sameSite). ' +
      'Consider using cookie jar or Set-Cookie headers instead.'
  );

  const cookies: PlaywrightCookie[] = [];
  const pairs = cookieHeader.split(';').map((s) => s.trim());

  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;

    const name = pair.substring(0, eqIndex).trim();
    const value = pair.substring(eqIndex + 1).trim();

    if (!name) continue;

    cookies.push({
      name,
      value,
      domain,
      path: '/',
      expires: -1, // Session cookie (we don't know the real expiry)
      httpOnly: true, // Conservative assumption
      secure: true, // Conservative assumption for HTTPS
      sameSite: 'Lax', // Conservative default
    });
  }

  return {
    cookies,
    origins: [{ origin: 'https://app.aryeo.com', localStorage: [] }],
  };
}
