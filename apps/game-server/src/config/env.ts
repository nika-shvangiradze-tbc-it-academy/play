import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseCorsOrigins } from './cors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load monorepo root .env then package-local override.
// From src/config or dist/config: ../../../../ = repo root, ../../ = apps/game-server
config({ path: resolve(__dirname, '../../../../.env') });
config({ path: resolve(__dirname, '../../.env') });

/** Classify a server key without logging its value. */
export function describeSupabaseServerKey(key: string): string {
  if (key.startsWith('sb_secret_')) return 'secret';
  if (key.startsWith('eyJ')) return 'legacy_service_role_jwt';
  if (key.startsWith('sb_publishable_')) return 'publishable_MISCONFIGURED';
  if (key.startsWith('sb_')) return 'unknown_sb_prefix';
  return 'unrecognized';
}

function looksLikeSecretServerKey(key: string): boolean {
  return key.startsWith('sb_secret_') || key.startsWith('eyJ');
}

/**
 * Prefer modern Supabase API key names; accept legacy aliases for migration.
 * Never use SUPABASE_JWT_SECRET — user JWTs are verified via JWKS (ES256).
 */
const envSchema = z
  .object({
    PORT: z.coerce.number().default(2567),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    SUPABASE_URL: z.string().url(),
    SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
    SUPABASE_SECRET_KEY: z.string().min(1).optional(),
    SUPABASE_ANON_KEY: z.string().min(1).optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
    RECONNECT_GRACE_MS: z.coerce.number().default(60_000),
    RATE_LIMIT_CREATE_ROOM_PER_MIN: z.coerce.number().default(10),
    RATE_LIMIT_JOIN_ROOM_PER_MIN: z.coerce.number().default(30),
    /**
     * Public hostname clients use for Colyseus WebSockets (no protocol).
     * Example: play-2cb4.onrender.com
     * Falls back to RENDER_EXTERNAL_HOSTNAME when unset.
     */
    PUBLIC_ADDRESS: z.string().min(1).optional(),
    RENDER_EXTERNAL_HOSTNAME: z.string().min(1).optional(),
    /** Preferred: comma-separated browser origins. */
    CORS_ORIGINS: z.string().optional(),
    /** Legacy single/csv alias — used only when CORS_ORIGINS is unset. */
    CORS_ORIGIN: z.string().optional(),
  })
  .superRefine((raw, ctx) => {
    if (!raw.SUPABASE_PUBLISHABLE_KEY && !raw.SUPABASE_ANON_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SUPABASE_PUBLISHABLE_KEY'],
        message: 'Required (or set legacy SUPABASE_ANON_KEY)',
      });
    }
    if (!raw.SUPABASE_SECRET_KEY && !raw.SUPABASE_SERVICE_ROLE_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SUPABASE_SECRET_KEY'],
        message: 'Required (or set legacy SUPABASE_SERVICE_ROLE_KEY)',
      });
    }

    const secret = raw.SUPABASE_SECRET_KEY ?? raw.SUPABASE_SERVICE_ROLE_KEY;
    const publishable = raw.SUPABASE_PUBLISHABLE_KEY ?? raw.SUPABASE_ANON_KEY;

    if (secret?.startsWith('sb_publishable_')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SUPABASE_SECRET_KEY'],
        message: 'Must be sb_secret_… (or legacy service_role JWT), not a publishable key',
      });
    }
    if (publishable?.startsWith('sb_secret_')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SUPABASE_PUBLISHABLE_KEY'],
        message: 'Must be sb_publishable_… (or legacy anon JWT), not a secret key',
      });
    }
    if (secret && publishable && secret === publishable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SUPABASE_SECRET_KEY'],
        message: 'Must differ from the publishable/anon key',
      });
    }
    if (secret && !looksLikeSecretServerKey(secret) && secret.startsWith('sb_')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SUPABASE_SECRET_KEY'],
        message: 'Unrecognized key format — expected sb_secret_… or legacy service_role JWT',
      });
    }
  })
  .transform((raw) => {
    // Prefer CORS_ORIGINS; fall back to legacy CORS_ORIGIN; else localhost-only defaults.
    const corsRaw =
      raw.CORS_ORIGINS !== undefined && raw.CORS_ORIGINS.trim() !== ''
        ? raw.CORS_ORIGINS
        : raw.CORS_ORIGIN;
    return {
      PORT: raw.PORT,
      NODE_ENV: raw.NODE_ENV,
      SUPABASE_URL: raw.SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: (raw.SUPABASE_PUBLISHABLE_KEY ?? raw.SUPABASE_ANON_KEY)!,
      SUPABASE_SECRET_KEY: (raw.SUPABASE_SECRET_KEY ?? raw.SUPABASE_SERVICE_ROLE_KEY)!,
      RECONNECT_GRACE_MS: raw.RECONNECT_GRACE_MS,
      RATE_LIMIT_CREATE_ROOM_PER_MIN: raw.RATE_LIMIT_CREATE_ROOM_PER_MIN,
      RATE_LIMIT_JOIN_ROOM_PER_MIN: raw.RATE_LIMIT_JOIN_ROOM_PER_MIN,
      PUBLIC_ADDRESS: (raw.PUBLIC_ADDRESS ?? raw.RENDER_EXTERNAL_HOSTNAME)?.replace(
        /^https?:\/\//,
        '',
      ),
      CORS_ORIGINS: parseCorsOrigins(corsRaw),
    };
  });

export type ServerEnv = z.output<typeof envSchema>;

let cached: ServerEnv | null = null;

export function getEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid server environment: ${details}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper — clears cached env between cases. */
export function resetEnvCache(): void {
  cached = null;
}

export function isDev(): boolean {
  return getEnv().NODE_ENV === 'development';
}

/** Log-safe summary of which server key kind is configured (never the value). */
export function logSupabaseKeyConfigOnce(): void {
  const env = getEnv();
  console.log(
    `[config] Supabase server key configured: ${describeSupabaseServerKey(env.SUPABASE_SECRET_KEY)}`,
  );
}
