import path from 'node:path';
import type { Config } from './types.js';

function getEnvOrThrow(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

function getEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

export function loadConfig(): Config {
  const dataDir = getEnvOrDefault('DATA_DIR', './data');
  const port = getEnvInt('RUNNER_PORT', 8080);

  return {
    // Core settings
    port,
    authToken: getEnvOrThrow('RUNNER_AUTH_TOKEN'),
    allowedHosts: getEnvOrDefault(
      'ALLOWED_HOSTS',
      'cdn.virtualxposure.com,youriguide.com,app.aryeo.com'
    )
      .split(',')
      .map((h) => h.trim().toLowerCase()),
    redisUrl: getEnvOrDefault('REDIS_URL', 'redis://localhost:6379'),

    // Playwright settings
    playwrightHeadless: getEnvBool('PLAYWRIGHT_HEADLESS', true),
    playwrightTimeout: getEnvInt('PLAYWRIGHT_TIMEOUT_MS', 60000),

    // Data directories
    dataDir,
    storageStatePath: path.join(dataDir, 'auth', 'aryeo-storage-state.json'),

    // Production settings
    publicBaseUrl: getEnvOrDefault('PUBLIC_BASE_URL', `http://localhost:${port}`),
    callbackTimeoutMs: getEnvInt('CALLBACK_TIMEOUT_MS', 30000),
    jobTimeoutMs: getEnvInt('JOB_TIMEOUT_MS', 300000), // 5 minutes
    maxRetries: getEnvInt('MAX_RETRIES', 3),

    // Rate limiting (in-memory)
    rateLimitWindowMs: getEnvInt('RATE_LIMIT_WINDOW_MS', 60000), // 1 minute
    rateLimitMaxRequests: getEnvInt('RATE_LIMIT_MAX_REQUESTS', 30), // 30 req/min

    // Safe mode - when true, deliver_after_attach is forced to false
    safeMode: getEnvBool('SAFE_MODE', false),

    // Trust proxy headers (X-Forwarded-For, etc.) when behind Cloudflare/nginx
    trustProxy: getEnvBool('TRUST_PROXY', true),
  };
}

// Singleton config instance
let configInstance: Config | null = null;

export function getConfig(): Config {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}

// Allow resetting config (useful for testing)
export function resetConfig(): void {
  configInstance = null;
}
