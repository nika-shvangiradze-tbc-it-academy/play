import { describe, expect, it } from 'vitest';
import {
  GameType,
  getMaxPlayers,
  normalizeInviteCode,
  isValidInviteCodeFormat,
} from '@georgian-games/shared';

/**
 * Lightweight contract tests for room/join helpers used by the HTTP API.
 * Full authenticated integration requires a live Supabase project.
 */
describe('room join contracts', () => {
  it('normalizes invite codes for lookup', () => {
    expect(normalizeInviteCode(' ab12cd ')).toBe('AB12CD');
  });

  it('rejects malformed codes before DB hit', () => {
    expect(isValidInviteCodeFormat('NO')).toBe(false);
    expect(isValidInviteCodeFormat('ABCDEF')).toBe(true);
  });

  it('enforces nardi capacity of 2', () => {
    expect(getMaxPlayers(GameType.NARDI)).toBe(2);
  });
});
