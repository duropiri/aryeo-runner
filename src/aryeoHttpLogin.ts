/**
 * Non-Playwright HTTP-based login for Aryeo.
 *
 * This module performs authentication via direct HTTP requests using undici,
 * capturing cookies in a tough-cookie jar for later conversion to Playwright
 * storage state format.
 *
 * Usage:
 *   const result = await loginToAryeo(email, password);
 *   // result.cookieJar contains all session cookies
 */

import { CookieJar, Cookie } from 'tough-cookie';
import { fetch, type Response } from 'undici';

const ARYEO_BASE_URL = 'https://app.aryeo.com';
const ARYEO_LOGIN_URL = `${ARYEO_BASE_URL}/login`;
const ARYEO_DASHBOARD_URL = `${ARYEO_BASE_URL}/admin`;

export interface LoginResult {
  success: boolean;
  cookieJar: CookieJar;
  error?: string;
  redirectUrl?: string;
}

export interface SessionVerification {
  valid: boolean;
  url: string;
  statusCode: number;
  error?: string;
}

/**
 * Extract CSRF token from cookies (XSRF-TOKEN) or HTML meta tag.
 */
function extractXsrfFromCookies(cookieJar: CookieJar): string | null {
  const cookies = cookieJar.getCookiesSync(ARYEO_BASE_URL);
  const xsrfCookie = cookies.find((c) => c.key === 'XSRF-TOKEN');
  if (xsrfCookie) {
    // Laravel's XSRF-TOKEN is URL-encoded, decode it
    try {
      return decodeURIComponent(xsrfCookie.value);
    } catch {
      return xsrfCookie.value;
    }
  }
  return null;
}

/**
 * Extract CSRF token from HTML content (meta tag or hidden input).
 */
function extractCsrfFromHtml(html: string): string | null {
  // Try meta tag first: <meta name="csrf-token" content="...">
  const metaMatch = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/i);
  if (metaMatch && metaMatch[1]) {
    return metaMatch[1];
  }

  // Try hidden input: <input type="hidden" name="_token" value="...">
  const inputMatch = html.match(/<input[^>]+name="_token"[^>]+value="([^"]+)"/i);
  if (inputMatch && inputMatch[1]) {
    return inputMatch[1];
  }

  // Alternative input format
  const altInputMatch = html.match(/<input[^>]+value="([^"]+)"[^>]+name="_token"/i);
  if (altInputMatch && altInputMatch[1]) {
    return altInputMatch[1];
  }

  return null;
}

/**
 * Apply Set-Cookie headers from a response to the cookie jar.
 */
function applySetCookieHeaders(response: Response, url: string, cookieJar: CookieJar): void {
  const setCookieHeaders = response.headers.getSetCookie();
  for (const setCookie of setCookieHeaders) {
    try {
      const cookie = Cookie.parse(setCookie);
      if (cookie) {
        cookieJar.setCookieSync(cookie, url);
      }
    } catch (err) {
      // Ignore malformed cookies
      console.warn(`Failed to parse Set-Cookie: ${setCookie}`);
    }
  }
}

/**
 * Build Cookie header string from jar for a given URL.
 */
function buildCookieHeader(cookieJar: CookieJar, url: string): string {
  const cookies = cookieJar.getCookiesSync(url);
  return cookies.map((c) => `${c.key}=${c.value}`).join('; ');
}

/**
 * Perform a fetch request that integrates with tough-cookie jar.
 */
async function fetchWithCookies(
  url: string,
  cookieJar: CookieJar,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    redirect?: 'follow' | 'manual' | 'error';
  } = {}
): Promise<Response> {
  const cookieHeader = buildCookieHeader(cookieJar, url);

  const headers: Record<string, string> = {
    'User-Agent': 'AryeoStorageStateExporter/1.0',
    ...(options.headers || {}),
  };

  if (cookieHeader) {
    headers['Cookie'] = cookieHeader;
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body,
    redirect: options.redirect || 'manual',
  });

  // Apply Set-Cookie headers to jar
  applySetCookieHeaders(response, url, cookieJar);

  return response;
}

/**
 * Follow redirects manually to capture cookies at each step.
 */
async function followRedirects(
  response: Response,
  cookieJar: CookieJar,
  maxRedirects: number = 10
): Promise<{ finalResponse: Response; finalUrl: string }> {
  let currentResponse = response;
  let currentUrl = response.url;
  let redirectCount = 0;

  while (
    redirectCount < maxRedirects &&
    (currentResponse.status === 301 ||
      currentResponse.status === 302 ||
      currentResponse.status === 303 ||
      currentResponse.status === 307 ||
      currentResponse.status === 308)
  ) {
    const location = currentResponse.headers.get('location');
    if (!location) break;

    // Resolve relative URLs
    const nextUrl = new URL(location, currentUrl).toString();
    currentUrl = nextUrl;

    currentResponse = await fetchWithCookies(nextUrl, cookieJar, {
      method: 'GET',
      redirect: 'manual',
    });

    redirectCount++;
  }

  return { finalResponse: currentResponse, finalUrl: currentUrl };
}

/**
 * Login to Aryeo using email and password.
 *
 * This performs the full login flow:
 * 1. GET /login to obtain CSRF token and initial cookies
 * 2. POST /login with credentials
 * 3. Follow redirects to capture session cookies
 *
 * @param email - Aryeo account email (from ARYEO_EMAIL env var)
 * @param password - Aryeo account password (from ARYEO_PASSWORD env var)
 * @returns LoginResult with cookie jar on success
 */
export async function loginToAryeo(email: string, password: string): Promise<LoginResult> {
  const cookieJar = new CookieJar();

  try {
    // Step 1: GET login page to obtain CSRF token
    console.log('Fetching login page...');
    const loginPageResponse = await fetchWithCookies(ARYEO_LOGIN_URL, cookieJar);

    if (loginPageResponse.status !== 200) {
      return {
        success: false,
        cookieJar,
        error: `Failed to fetch login page: HTTP ${loginPageResponse.status}`,
      };
    }

    const loginPageHtml = await loginPageResponse.text();

    // Extract CSRF token
    let csrfToken = extractXsrfFromCookies(cookieJar);
    const htmlCsrfToken = extractCsrfFromHtml(loginPageHtml);

    if (!csrfToken && !htmlCsrfToken) {
      return {
        success: false,
        cookieJar,
        error: 'Could not find CSRF token in cookies or HTML. Aryeo login page may have changed.',
      };
    }

    // Prefer HTML token for form submission, use cookie token for X-XSRF-TOKEN header
    const formToken = htmlCsrfToken || csrfToken;

    console.log('CSRF token obtained, submitting login...');

    // Step 2: POST login credentials
    const formData = new URLSearchParams();
    formData.append('email', email);
    formData.append('password', password);
    formData.append('_token', formToken!);
    formData.append('remember', 'on'); // Request persistent session

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: ARYEO_LOGIN_URL,
      Origin: ARYEO_BASE_URL,
    };

    // Add X-XSRF-TOKEN header if we have the cookie value
    if (csrfToken) {
      headers['X-XSRF-TOKEN'] = csrfToken;
    }

    const loginResponse = await fetchWithCookies(ARYEO_LOGIN_URL, cookieJar, {
      method: 'POST',
      headers,
      body: formData.toString(),
      redirect: 'manual',
    });

    // Step 3: Follow redirects to capture all session cookies
    const { finalResponse, finalUrl } = await followRedirects(loginResponse, cookieJar);

    // Check if login was successful
    // Success indicators:
    // - Redirected to /admin or /dashboard
    // - Have aryeo_session cookie
    // - No login page indicators in final response

    const cookies = cookieJar.getCookiesSync(ARYEO_BASE_URL);
    const hasSessionCookie = cookies.some((c) => c.key === 'aryeo_session');

    if (!hasSessionCookie) {
      // Check if we're still on login page (failed login)
      const finalHtml = await finalResponse.text();
      if (finalHtml.includes('These credentials do not match') || finalHtml.includes('login')) {
        return {
          success: false,
          cookieJar,
          error: 'Login failed: Invalid credentials or account issue',
        };
      }

      return {
        success: false,
        cookieJar,
        error: 'Login appeared to complete but no session cookie was set',
      };
    }

    // Verify we're on an authenticated page
    const isAuthenticatedUrl =
      finalUrl.includes('/admin') ||
      finalUrl.includes('/dashboard') ||
      finalUrl.includes('/listings');

    if (!isAuthenticatedUrl && loginResponse.status !== 302) {
      return {
        success: false,
        cookieJar,
        error: `Login did not redirect to authenticated area. Final URL: ${finalUrl}`,
      };
    }

    console.log('Login successful!');
    return {
      success: true,
      cookieJar,
      redirectUrl: finalUrl,
    };
  } catch (err) {
    return {
      success: false,
      cookieJar,
      error: `Login request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Verify that a session is still valid by requesting an authenticated endpoint.
 *
 * @param cookieJar - Cookie jar with session cookies
 * @param testUrl - URL to test (defaults to /admin)
 * @returns SessionVerification result
 */
export async function verifySession(
  cookieJar: CookieJar,
  testUrl: string = ARYEO_DASHBOARD_URL
): Promise<SessionVerification> {
  try {
    const response = await fetchWithCookies(testUrl, cookieJar, {
      redirect: 'manual',
    });

    // Follow any redirects
    const { finalResponse, finalUrl } = await followRedirects(response, cookieJar);

    // Check if we ended up on login page (session expired)
    const isLoginPage = finalUrl.includes('/login');

    if (isLoginPage) {
      return {
        valid: false,
        url: finalUrl,
        statusCode: finalResponse.status,
        error: 'Session expired or invalid - redirected to login page',
      };
    }

    // Check for successful authenticated page
    if (finalResponse.status === 200) {
      return {
        valid: true,
        url: finalUrl,
        statusCode: 200,
      };
    }

    return {
      valid: false,
      url: finalUrl,
      statusCode: finalResponse.status,
      error: `Unexpected status code: ${finalResponse.status}`,
    };
  } catch (err) {
    return {
      valid: false,
      url: testUrl,
      statusCode: 0,
      error: `Verification request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Get all cookies from the jar for Aryeo domains.
 */
export function getAryeoCookies(cookieJar: CookieJar): Cookie[] {
  const urls = [
    ARYEO_BASE_URL,
    'https://aryeo.com',
    'https://www.aryeo.com',
  ];

  const allCookies: Cookie[] = [];
  const seen = new Set<string>();

  for (const url of urls) {
    const cookies = cookieJar.getCookiesSync(url);
    for (const cookie of cookies) {
      const key = `${cookie.key}:${cookie.domain}:${cookie.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        allCookies.push(cookie);
      }
    }
  }

  return allCookies;
}
