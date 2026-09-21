import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limiter.js';

describe('RateLimiter', () => {
  it('allows up to max then blocks', () => {
    const limiter = new RateLimiter(2, 60_000);
    expect(limiter.tryRemoveToken('a')).toBe(true);
    expect(limiter.tryRemoveToken('a')).toBe(true);
    expect(limiter.tryRemoveToken('a')).toBe(false);
    expect(limiter.tryRemoveToken('b')).toBe(true);
  });
});
