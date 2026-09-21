/**
 * Human-friendly invite codes.
 * Uppercase, cryptographically random, ambiguous characters excluded.
 * Alphabet omits: 0/O, 1/I/L to reduce mistypes.
 *
 * Uses Web Crypto (available in Node 20+ and browsers) so this module
 * is safe to import from both the game server and Angular.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_ATTEMPTS = 32;

function secureRandomInt(maxExclusive: number): number {
  if (maxExclusive <= 0) {
    throw new Error('maxExclusive must be positive');
  }
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.getRandomValues) {
    throw new Error('Secure random generator unavailable');
  }
  // Rejection sampling to avoid modulo bias
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  let x: number;
  do {
    cryptoObj.getRandomValues(buf);
    x = buf[0]!;
  } while (x >= limit);
  return x % maxExclusive;
}

export function normalizeInviteCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidInviteCodeFormat(code: string): boolean {
  const normalized = normalizeInviteCode(code);
  if (normalized.length !== CODE_LENGTH) {
    return false;
  }
  for (const ch of normalized) {
    if (!ALPHABET.includes(ch)) {
      return false;
    }
  }
  return true;
}

/** Generate a single cryptographically secure invite code. */
export function generateInviteCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[secureRandomInt(ALPHABET.length)];
  }
  return code;
}

/**
 * Generate a unique invite code, retrying on collision.
 * `exists` should return true if the code is already taken.
 */
export async function generateUniqueInviteCode(
  exists: (code: string) => Promise<boolean>,
  maxAttempts = MAX_ATTEMPTS,
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = generateInviteCode();
    if (!(await exists(code))) {
      return code;
    }
  }
  throw new Error('Failed to generate unique invite code after maximum attempts');
}

export const INVITE_CODE_ALPHABET = ALPHABET;
export const INVITE_CODE_LENGTH = CODE_LENGTH;
