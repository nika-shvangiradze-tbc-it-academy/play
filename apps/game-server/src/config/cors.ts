import type { CorsOptions } from 'cors';

const DEV_DEFAULT_ORIGINS = ['http://localhost:4200'] as const;

/**
 * Parse a comma-separated origin list.
 * Empty / whitespace-only entries are dropped.
 */
export function parseCorsOrigins(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [...DEV_DEFAULT_ORIGINS];
  }
  const origins = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return origins.length > 0 ? origins : [...DEV_DEFAULT_ORIGINS];
}

export function createCorsOptions(allowedOrigins: readonly string[]): CorsOptions {
  const allowed = new Set(allowedOrigins);

  return {
    origin(origin, callback) {
      // Non-browser clients (curl, Render health) send no Origin.
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowed.has(origin)) {
        // Echo the exact origin — never "*' when credentials are used.
        callback(null, origin);
        return;
      }
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
  };
}
