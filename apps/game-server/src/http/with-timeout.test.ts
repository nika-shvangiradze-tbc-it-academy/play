import { describe, expect, it } from 'vitest';
import { TimeoutError, withTimeout } from './with-timeout.js';

describe('withTimeout', () => {
  it('resolves when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, 'fast')).resolves.toBe(42);
  });

  it('rejects with TimeoutError when the promise never settles', async () => {
    const pending = new Promise<number>(() => {
      /* never settles */
    });
    const started = Date.now();
    await expect(withTimeout(pending, 50, 'hang')).rejects.toBeInstanceOf(TimeoutError);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
