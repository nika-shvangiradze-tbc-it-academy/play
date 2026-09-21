import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load monorepo root .env then package-local override.
// From src/config or dist/config: ../../../../ = repo root, ../../ = apps/game-server
config({ path: resolve(__dirname, '../../../../.env') });
config({ path: resolve(__dirname, '../../.env') });

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
    CORS_ORIGIN: z.string().default('http://localhost:4200'),
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
  })
  .transform((raw) => ({
    PORT: raw.PORT,
    NODE_ENV: raw.NODE_ENV,
    SUPABASE_URL: raw.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: (raw.SUPABASE_PUBLISHABLE_KEY ?? raw.SUPABASE_ANON_KEY)!,
    SUPABASE_SECRET_KEY: (raw.SUPABASE_SECRET_KEY ?? raw.SUPABASE_SERVICE_ROLE_KEY)!,
    RECONNECT_GRACE_MS: raw.RECONNECT_GRACE_MS,
    RATE_LIMIT_CREATE_ROOM_PER_MIN: raw.RATE_LIMIT_CREATE_ROOM_PER_MIN,
    RATE_LIMIT_JOIN_ROOM_PER_MIN: raw.RATE_LIMIT_JOIN_ROOM_PER_MIN,
    CORS_ORIGIN: raw.CORS_ORIGIN,
  }));

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
