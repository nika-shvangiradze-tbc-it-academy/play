import { describe, expect, it } from 'vitest';
import {
  generateInviteCode,
  generateUniqueInviteCode,
  isValidInviteCodeFormat,
  normalizeInviteCode,
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
} from './invite-code.js';

describe('invite codes', () => {
  it('normalizes lowercase and whitespace', () => {
    expect(normalizeInviteCode('  ab12cd  ')).toBe('AB12CD');
  });

  it('generates codes of correct length from safe alphabet', () => {
    for (let i = 0; i < 20; i++) {
      const code = generateInviteCode();
      expect(code).toHaveLength(INVITE_CODE_LENGTH);
      for (const ch of code) {
        expect(INVITE_CODE_ALPHABET).toContain(ch);
      }
      expect(isValidInviteCodeFormat(code)).toBe(true);
    }
  });

  it('rejects ambiguous / invalid formats', () => {
    expect(isValidInviteCodeFormat('ABC1O0')).toBe(false); // O and 0 not in alphabet
    expect(isValidInviteCodeFormat('AB')).toBe(false);
    expect(isValidInviteCodeFormat('')).toBe(false);
  });

  it('retries on collision until unique', async () => {
    const seen = new Set<string>();
    let calls = 0;
    const code = await generateUniqueInviteCode(async (c) => {
      calls++;
      if (calls < 3) {
        seen.add(c);
        return true;
      }
      return seen.has(c);
    });
    expect(code).toHaveLength(INVITE_CODE_LENGTH);
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});
