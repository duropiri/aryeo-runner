import crypto from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { getConfig } from './config.js';
import { ErrorCodes } from './types.js';
import { logger } from './logger.js';

/**
 * Validates the Authorization bearer token from the request
 */
export function validateBearerToken(request: FastifyRequest, reply: FastifyReply): boolean {
  const config = getConfig();
  const authHeader = request.headers.authorization;

  if (!authHeader) {
    logger.warn({ path: request.url }, 'Missing Authorization header');
    reply.status(401).send({
      error: {
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Missing Authorization header',
      },
    });
    return false;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') {
    logger.warn({ path: request.url }, 'Invalid Authorization header format');
    reply.status(401).send({
      error: {
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Invalid Authorization header format. Expected: Bearer <token>',
      },
    });
    return false;
  }

  const token = parts[1];
  if (token !== config.authToken) {
    logger.warn({ path: request.url }, 'Invalid bearer token');
    reply.status(401).send({
      error: {
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Invalid bearer token',
      },
    });
    return false;
  }

  return true;
}

/**
 * Validates that a URL's hostname is in the allowlist
 */
export function isHostAllowed(urlString: string): boolean {
  const config = getConfig();

  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();

    // Check if the hostname matches any allowed host
    return config.allowedHosts.some((allowed) => {
      // Exact match or subdomain match
      return hostname === allowed || hostname.endsWith(`.${allowed}`);
    });
  } catch {
    logger.error({ url: urlString }, 'Invalid URL format');
    return false;
  }
}

/**
 * Validates multiple URLs against the allowlist
 * Returns the first disallowed URL or null if all are allowed
 */
export function findDisallowedHost(urls: string[]): string | null {
  for (const url of urls) {
    if (!isHostAllowed(url)) {
      return url;
    }
  }
  return null;
}

/**
 * Creates an HMAC-SHA256 signature for the callback payload.
 *
 * Signature scheme: HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
 *
 * This binds the timestamp cryptographically to the signature, preventing
 * replay attacks where an attacker could reuse an old signature with a new timestamp.
 *
 * @param timestamp - Unix milliseconds timestamp as a string
 * @param rawBody - The exact JSON string that will be sent as the request body
 * @param secret - The webhook secret
 * @returns Hex-encoded HMAC-SHA256 signature
 */
export function createCallbackSignature(timestamp: string, rawBody: string, secret: string): string {
  const signaturePayload = `${timestamp}.${rawBody}`;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(signaturePayload);
  return hmac.digest('hex');
}

/**
 * Verifies an HMAC-SHA256 callback signature.
 *
 * @param timestamp - The X-VX-Timestamp header value
 * @param rawBody - The raw request body string
 * @param signature - The X-VX-Signature header value
 * @param secret - The webhook secret
 * @returns true if signature is valid
 */
export function verifyCallbackSignature(
  timestamp: string,
  rawBody: string,
  signature: string,
  secret: string
): boolean {
  const expectedSignature = createCallbackSignature(timestamp, rawBody, secret);
  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Creates signed headers for callback requests.
 *
 * Headers sent:
 * - X-VX-Timestamp: Unix milliseconds timestamp (e.g., "1705317000000")
 * - X-VX-Signature: HMAC-SHA256 hex signature over `${timestamp}.${rawBody}`
 *
 * The rawBody passed here MUST be the exact same string used as the request body.
 * Do not re-stringify after calling this function.
 *
 * @param rawBody - The exact JSON string that will be sent as the request body
 * @param secret - The webhook secret
 * @returns Headers object including Content-Type, X-VX-Timestamp, and X-VX-Signature
 */
export function createCallbackHeaders(rawBody: string, secret: string): Record<string, string> {
  // Use Unix milliseconds for timestamp - unambiguous and easy to parse
  const timestamp = Date.now().toString();
  const signature = createCallbackSignature(timestamp, rawBody, secret);

  return {
    'Content-Type': 'application/json',
    'X-VX-Timestamp': timestamp,
    'X-VX-Signature': signature,
  };
}

// =============================================================================
// Legacy functions (kept for backwards compatibility, but prefer the new ones)
// =============================================================================

/**
 * @deprecated Use createCallbackSignature instead
 */
export function createHmacSignature(payload: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  return hmac.digest('hex');
}

/**
 * @deprecated Use verifyCallbackSignature instead
 */
export function verifyHmacSignature(payload: string, signature: string, secret: string): boolean {
  const expectedSignature = createHmacSignature(payload, secret);
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'));
  } catch {
    return false;
  }
}
