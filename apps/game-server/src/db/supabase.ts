import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getEnv, describeSupabaseServerKey } from '../config/env.js';

let admin: SupabaseClient | null = null;
let loggedKeyKind = false;

/**
 * Strip Authorization when it incorrectly carries an sb_secret_ key as Bearer.
 * New Supabase API keys are not JWTs — they belong only on the `apikey` header.
 * @supabase/supabase-js may still attach Bearer <key>; PostgREST then mis-auth's.
 */
function createSecretKeyFetch(secretKey: string): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.has('apikey')) {
      headers.set('apikey', secretKey);
    }
    const auth = headers.get('Authorization');
    if (
      secretKey.startsWith('sb_secret_') &&
      auth === `Bearer ${secretKey}`
    ) {
      headers.delete('Authorization');
    }
    return fetch(input, { ...init, headers });
  };
}

/** Secret-key client — server only. Bypasses RLS. Never expose to Angular. */
export function getAdminClient(): SupabaseClient {
  if (admin) return admin;
  const env = getEnv();

  if (!loggedKeyKind) {
    console.log(
      `[supabase] server admin client key: ${describeSupabaseServerKey(env.SUPABASE_SECRET_KEY)}`,
    );
    loggedKeyKind = true;
  }

  admin = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      fetch: createSecretKeyFetch(env.SUPABASE_SECRET_KEY),
    },
  });
  return admin;
}
