/**
 * Username rules:
 * - 3–20 characters
 * - letters, numbers, underscore
 * - case-insensitive uniqueness (normalized to lowercase for storage key)
 */
const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/;

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function isValidUsername(username: string): boolean {
  const trimmed = username.trim();
  return USERNAME_REGEX.test(trimmed);
}

export function validateUsername(username: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = username.trim();
  if (trimmed.length < 3) {
    return { ok: false, reason: 'Username must be at least 3 characters' };
  }
  if (trimmed.length > 20) {
    return { ok: false, reason: 'Username must be at most 20 characters' };
  }
  if (!USERNAME_REGEX.test(trimmed)) {
    return { ok: false, reason: 'Username may only contain letters, numbers, and underscores' };
  }
  return { ok: true };
}
