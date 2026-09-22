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
    return { ok: false, reason: 'სახელი უნდა იყოს მინიმუმ 3 სიმბოლო' };
  }
  if (trimmed.length > 20) {
    return { ok: false, reason: 'სახელი უნდა იყოს მაქსიმუმ 20 სიმბოლო' };
  }
  if (!USERNAME_REGEX.test(trimmed)) {
    return { ok: false, reason: 'სახელი შეიძლება შეიცავდეს მხოლოდ ასოებს, ციფრებს და ქვედა ტირეს' };
  }
  return { ok: true };
}
