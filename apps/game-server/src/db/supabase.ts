import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getEnv } from '../config/env.js';

let admin: SupabaseClient | null = null;

/** Secret-key client — server only. Bypasses RLS. Never expose to Angular. */
export function getAdminClient(): SupabaseClient {
  if (admin) return admin;
  const env = getEnv();
  admin = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return admin;
}
