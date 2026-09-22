import { describe, expect, it, vi, afterEach } from 'vitest';
import { startEndGameCelebration } from './end-game-celebration';

function fakeCanvas(): HTMLCanvasElement {
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    fillRect: vi.fn(),
    createRadialGradient: () => ({ addColorStop: vi.fn() }),
    fillStyle: '',
    globalAlpha: 1,
  };
  return {
    width: 0,
    height: 0,
    style: {} as CSSStyleDeclaration,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
}

describe('end-game celebration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a no-op disposer for defeat / reduced motion', () => {
    const canvas = fakeCanvas();
    const stop = startEndGameCelebration(canvas, {
      mode: 'defeat',
      intensity: 'full',
      reducedMotion: false,
    });
    expect(typeof stop).toBe('function');
    stop();

    const stop2 = startEndGameCelebration(canvas, {
      mode: 'victory',
      intensity: 'full',
      reducedMotion: true,
    });
    stop2();
  });

  it('starts rAF for victory and cleans up on dispose', () => {
    const canvas = fakeCanvas();
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      value: vi.fn(() => 1),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'setTimeout', {
      value: ((fn: TimerHandler) => {
        if (typeof fn === 'function') fn();
        return 1;
      }) as typeof setTimeout,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'clearTimeout', {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'addEventListener', {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'removeEventListener', {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'innerWidth', { value: 800, configurable: true });
    Object.defineProperty(globalThis, 'innerHeight', { value: 600, configurable: true });
    Object.defineProperty(globalThis, 'devicePixelRatio', { value: 1, configurable: true });
    Object.defineProperty(globalThis, 'performance', {
      value: { now: () => 0 },
      configurable: true,
    });

    const stop = startEndGameCelebration(canvas, {
      mode: 'victory',
      intensity: 'full',
      reducedMotion: false,
    });
    expect(globalThis.requestAnimationFrame).toHaveBeenCalled();
    stop();
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalled();
  });
});
