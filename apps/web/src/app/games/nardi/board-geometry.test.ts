import { describe, expect, it } from 'vitest';
import {
  BOARD_ASPECT,
  computeBoardGeometry,
  computeStackLayout,
  fitBoardSize,
} from './board-geometry';

describe('fitBoardSize', () => {
  it('fits width-limited stages', () => {
    const { width, height } = fitBoardSize({ stageWidth: 390, stageHeight: 500 });
    expect(width).toBeLessThanOrEqual(390);
    expect(height).toBeCloseTo(width / BOARD_ASPECT, 1);
    expect(height).toBeLessThanOrEqual(500);
  });

  it('fits height-limited stages (landscape phones)', () => {
    const { width, height } = fitBoardSize({ stageWidth: 844, stageHeight: 280 });
    expect(height).toBeLessThanOrEqual(280);
    expect(width).toBeCloseTo(height * BOARD_ASPECT, 1);
    expect(width).toBeLessThanOrEqual(844);
  });
});

describe('computeBoardGeometry', () => {
  it('derives checker size from point width with margin', () => {
    const geo = computeBoardGeometry(390, 390 / BOARD_ASPECT);
    expect(geo.pointWidth).toBeGreaterThan(0);
    expect(geo.checkerSize).toBeLessThan(geo.pointWidth);
    expect(geo.checkerSize / geo.pointWidth).toBeGreaterThanOrEqual(0.65);
    expect(geo.stackHeight).toBeGreaterThan(geo.checkerSize);
    expect(geo.barWidth + geo.quadrantWidth * 2).toBeCloseTo(geo.playingWidth, 0);
  });

  it('stays coherent on a tiny 320px board', () => {
    const geo = computeBoardGeometry(320, 320 / BOARD_ASPECT);
    expect(geo.checkerSize).toBeGreaterThanOrEqual(11);
    expect(geo.framePadding).toBeGreaterThanOrEqual(4);
    expect(geo.stackHeight).toBeGreaterThan(geo.checkerSize);
  });
});

describe('computeStackLayout', () => {
  const size = 28;
  const stackHeight = 140;

  it('uses preferred gap for small stacks', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const layout = computeStackLayout(n, size, stackHeight);
      expect(layout.visible).toBe(n);
      expect(layout.size).toBe(size);
      if (n >= 2) {
        const total = size + (n - 1) * layout.step;
        expect(total).toBeLessThanOrEqual(stackHeight + 0.01);
        expect(layout.step).toBeGreaterThanOrEqual(size);
      }
    }
  });

  it('compresses step before shrinking diameter', () => {
    const tight = 90;
    const layout = computeStackLayout(5, size, tight);
    expect(layout.size).toBe(size);
    expect(layout.visible).toBe(5);
    const total = size + 4 * layout.step;
    expect(total).toBeLessThanOrEqual(tight + 0.5);
    expect(layout.step).toBeLessThan(size);
    expect(layout.step).toBeGreaterThanOrEqual(size * 0.35);
  });

  it('fails gracefully for extreme 15-checker stacks', () => {
    const layout = computeStackLayout(15, size, stackHeight);
    expect(layout.visible).toBeGreaterThan(0);
    expect(layout.visible).toBeLessThanOrEqual(8);
    expect(layout.badge).toBe(15);
    if (layout.visible > 1) {
      const total = size + (layout.visible - 1) * layout.step;
      expect(total).toBeLessThanOrEqual(stackHeight + 1);
    }
  });

  it('keeps neighboring-point safety via diameter < point width', () => {
    const geo = computeBoardGeometry(375, 375 / BOARD_ASPECT);
    const layout = computeStackLayout(5, geo.checkerSize, geo.stackHeight);
    expect(layout.size).toBeLessThan(geo.pointWidth * 0.9);
  });
});
