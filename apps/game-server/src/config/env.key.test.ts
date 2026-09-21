import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  describeSupabaseServerKey,
  getEnv,
  resetEnvCache,
} from './env.js';

describe('describeSupabaseServerKey', () => {
  it('classifies modern and legacy server keys without exposing values', () => {
    expect(describeSupabaseServerKey('sb_secret_abc')).toBe('secret');
    expect(describeSupabaseServerKey('eyJhbGciOiJIUzI1NiJ9.payload.sig')).toBe(
      'legacy_service_role_jwt',
    );
    expect(describeSupabaseServerKey('sb_publishable_abc')).toBe(
      'publishable_MISCONFIGURED',
    );
  });
});

describe('env secret vs publishable validation', () => {
  const base = {
    SUPABASE_URL: 'https://example.supabase.co',
    PORT: '2567',
    NODE_ENV: 'test',
  };

  beforeEach(() => {
    resetEnvCache();
  });

  afterEach(() => {
    for (const key of [
      'SUPABASE_URL',
      'SUPABASE_PUBLISHABLE_KEY',
      'SUPABASE_SECRET_KEY',
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'PORT',
      'NODE_ENV',
    ]) {
      delete process.env[key];
    }
    resetEnvCache();
  });

  it('rejects publishable key used as SUPABASE_SECRET_KEY', () => {
    Object.assign(process.env, base, {
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_ok',
      SUPABASE_SECRET_KEY: 'sb_publishable_wrong',
    });
    expect(() => getEnv()).toThrow(/not a publishable key/i);
  });

  it('accepts sb_secret_ as the server key', () => {
    Object.assign(process.env, base, {
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_ok',
      SUPABASE_SECRET_KEY: 'sb_secret_ok',
    });
    const env = getEnv();
    expect(env.SUPABASE_SECRET_KEY).toBe('sb_secret_ok');
    expect(describeSupabaseServerKey(env.SUPABASE_SECRET_KEY)).toBe('secret');
  });
});
