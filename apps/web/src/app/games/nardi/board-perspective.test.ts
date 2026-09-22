import { describe, expect, it } from 'vitest';
import { BAR_POINT, OFF_POINT } from '@georgian-games/shared';
import {
  DISPLAY_BOTTOM_POINTS,
  DISPLAY_TOP_POINTS,
  barPlayerOrder,
  invertPoint,
  perspectiveFromSeat,
  toDisplayPoint,
  toLogicalPoint,
} from './board-perspective';

describe('board perspective mapping', () => {
  it('derives perspective from seat, not username', () => {
    expect(perspectiveFromSeat(0)).toBe('white');
    expect(perspectiveFromSeat(1)).toBe('black');
    expect(perspectiveFromSeat(null)).toBe('white');
    expect(perspectiveFromSeat(undefined)).toBe('white');
  });

  it('round-trips every point 1–24 for white and black', () => {
    for (let p = 1; p <= 24; p++) {
      expect(toLogicalPoint(toDisplayPoint(p, 'white'), 'white')).toBe(p);
      expect(toLogicalPoint(toDisplayPoint(p, 'black'), 'black')).toBe(p);
    }
  });

  it('leaves BAR and OFF unchanged', () => {
    for (const perspective of ['white', 'black'] as const) {
      expect(toDisplayPoint(BAR_POINT, perspective)).toBe(BAR_POINT);
      expect(toLogicalPoint(BAR_POINT, perspective)).toBe(BAR_POINT);
      expect(toDisplayPoint(OFF_POINT, perspective)).toBe(OFF_POINT);
      expect(toLogicalPoint(OFF_POINT, perspective)).toBe(OFF_POINT);
    }
  });

  it('uses 25-p inversion for black display coordinates', () => {
    expect(toDisplayPoint(1, 'black')).toBe(24);
    expect(toDisplayPoint(24, 'black')).toBe(1);
    expect(toDisplayPoint(13, 'black')).toBe(12);
    expect(toLogicalPoint(12, 'black')).toBe(13);
    expect(invertPoint(invertPoint(7))).toBe(7);
  });

  it('places each side home board on the near/bottom-right display slots', () => {
    // White home 1–6 occupies bottom-right display slots as themselves.
    expect(DISPLAY_BOTTOM_POINTS.slice(6)).toEqual([6, 5, 4, 3, 2, 1]);
    // Black home 19–24 maps onto those same display slots via 25-p.
    expect(DISPLAY_BOTTOM_POINTS.slice(6).map((d) => toLogicalPoint(d, 'black'))).toEqual([
      19, 20, 21, 22, 23, 24,
    ]);
    // Far top-right display slots show white home when viewed as black.
    expect(DISPLAY_TOP_POINTS.slice(6).map((d) => toLogicalPoint(d, 'black'))).toEqual([
      6, 5, 4, 3, 2, 1,
    ]);
  });

  it('keeps local bar zone on the near/bottom side', () => {
    expect(barPlayerOrder('white')).toEqual([1, 0]);
    expect(barPlayerOrder('black')).toEqual([0, 1]);
  });

  it('maps legal move endpoints through display↔logical for both perspectives', () => {
    const legal = [
      { from: 13, to: 9 },
      { from: BAR_POINT, to: 22 },
      { from: 4, to: OFF_POINT },
      { from: 19, to: 23 },
    ];
    for (const perspective of ['white', 'black'] as const) {
      for (const m of legal) {
        expect(toLogicalPoint(toDisplayPoint(m.from, perspective), perspective)).toBe(m.from);
        expect(toLogicalPoint(toDisplayPoint(m.to, perspective), perspective)).toBe(m.to);
      }
    }
  });

  it('maps White and Dark bar-entry destinations correctly under both cameras', () => {
    // White die 1–6 → canonical 24..19
    const whiteEntries = [24, 23, 22, 21, 20, 19];
    // Dark die 1–6 → canonical 1..6
    const darkEntries = [1, 2, 3, 4, 5, 6];

    for (const to of whiteEntries) {
      expect(toLogicalPoint(toDisplayPoint(to, 'white'), 'white')).toBe(to);
      expect(toLogicalPoint(toDisplayPoint(to, 'black'), 'black')).toBe(to);
    }
    for (const to of darkEntries) {
      expect(toLogicalPoint(toDisplayPoint(to, 'white'), 'white')).toBe(to);
      expect(toLogicalPoint(toDisplayPoint(to, 'black'), 'black')).toBe(to);
    }

    // Dark camera: white entry 22 appears on display slot 3; tap sends logical 22.
    expect(toDisplayPoint(22, 'black')).toBe(3);
    expect(toLogicalPoint(3, 'black')).toBe(22);
    // Dark camera: dark entry 3 appears on display slot 22; tap sends logical 3.
    expect(toDisplayPoint(3, 'black')).toBe(22);
    expect(toLogicalPoint(22, 'black')).toBe(3);
  });
});
