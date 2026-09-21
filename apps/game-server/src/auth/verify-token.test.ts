import { describe, expect, it } from 'vitest';
import { getSupabaseIssuer, getSupabaseJwksUrl } from './verify-token.js';

describe('Supabase JWKS auth helpers', () => {
  it('builds issuer from project URL', () => {
    expect(getSupabaseIssuer('https://abc.supabase.co')).toBe(
      'https://abc.supabase.co/auth/v1',
    );
    expect(getSupabaseIssuer('https://abc.supabase.co/')).toBe(
      'https://abc.supabase.co/auth/v1',
    );
  });

  it('builds JWKS discovery URL', () => {
    expect(getSupabaseJwksUrl('https://abc.supabase.co').href).toBe(
      'https://abc.supabase.co/auth/v1/.well-known/jwks.json',
    );
  });
});
