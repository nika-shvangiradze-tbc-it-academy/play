import { createRemoteJWKSet, errors as JoseErrors, jwtVerify } from 'jose';
import { ErrorCode } from '@georgian-games/shared';
import { getEnv } from '../config/env.js';
import { getAdminClient } from '../db/supabase.js';

export interface AuthUser {
  userId: string;
  email: string | undefined;
}

export interface AuthProfile extends AuthUser {
  username: string;
  avatarUrl: string | null;
}

export class AuthError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Issuer claim for JWTs minted by this Supabase project's Auth server. */
export function getSupabaseIssuer(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/$/, '')}/auth/v1`;
}

export function getSupabaseJwksUrl(supabaseUrl: string): URL {
  return new URL(`${getSupabaseIssuer(supabaseUrl)}/.well-known/jwks.json`);
}

let remoteJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let remoteJwksUrl: string | null = null;

function getProjectJwks(): ReturnType<typeof createRemoteJWKSet> {
  const url = getSupabaseJwksUrl(getEnv().SUPABASE_URL);
  const href = url.href;
  if (!remoteJwks || remoteJwksUrl !== href) {
    // jose caches JWKS and refreshes on unknown kid / expiry — do not add a long app-level cache.
    remoteJwks = createRemoteJWKSet(url);
    remoteJwksUrl = href;
  }
  return remoteJwks;
}

/**
 * Verify a Supabase Auth user access token via the project JWKS (ES256 / asymmetric).
 * Never trust a client-supplied userId — identity comes only from the verified `sub` claim.
 */
export async function verifyAccessToken(token: string): Promise<AuthUser> {
  if (!token || typeof token !== 'string') {
    throw new AuthError(ErrorCode.UNAUTHENTICATED, 'Missing access token');
  }

  const issuer = getSupabaseIssuer(getEnv().SUPABASE_URL);

  try {
    const { payload } = await jwtVerify(token, getProjectJwks(), {
      issuer,
      audience: 'authenticated',
      algorithms: ['ES256', 'RS256'],
      clockTolerance: 5,
    });

    const userId = payload.sub;
    if (!userId || typeof userId !== 'string') {
      throw new AuthError(ErrorCode.INVALID_TOKEN, 'Token missing subject');
    }

    const role = payload['role'];
    if (role !== undefined && role !== 'authenticated') {
      throw new AuthError(ErrorCode.INVALID_TOKEN, 'Token role is not authenticated');
    }

    const email = typeof payload['email'] === 'string' ? payload['email'] : undefined;
    return { userId, email };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    if (err instanceof JoseErrors.JWTExpired) {
      throw new AuthError(ErrorCode.EXPIRED_TOKEN, 'Session expired');
    }
    if (
      err instanceof JoseErrors.JWTClaimValidationFailed ||
      err instanceof JoseErrors.JWSSignatureVerificationFailed ||
      err instanceof JoseErrors.JWKSNoMatchingKey ||
      err instanceof JoseErrors.JWTInvalid
    ) {
      throw new AuthError(ErrorCode.INVALID_TOKEN, 'Invalid access token');
    }
    throw new AuthError(ErrorCode.INVALID_TOKEN, 'Invalid access token');
  }
}

export async function loadProfile(userId: string): Promise<AuthProfile> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, avatar_url')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load profile: ${error.message}`);
  }
  if (!data) {
    throw new AuthError(ErrorCode.UNAUTHENTICATED, 'Profile not found');
  }

  return {
    userId: data.id as string,
    email: undefined,
    username: data.username as string,
    avatarUrl: (data.avatar_url as string | null) ?? null,
  };
}

export async function authenticateToken(token: string): Promise<AuthProfile> {
  const user = await verifyAccessToken(token);
  const profile = await loadProfile(user.userId);
  return { ...profile, email: user.email };
}
