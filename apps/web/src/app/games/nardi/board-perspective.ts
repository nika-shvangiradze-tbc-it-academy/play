import { BAR_POINT, OFF_POINT, type NardiPlayerIndex } from '@georgian-games/shared';

/**
 * Board camera relative to the local player.
 * Derived from authoritative seat (0 = white, 1 = black) — never from username.
 *
 * SERVER STATE stays canonical (absolute points 1–24).
 * UI uses fixed white-view DISPLAY SLOTS; black perspective maps via 25 − n.
 */
export type BoardPerspective = 'white' | 'black';

/**
 * Display-slot coordinates (white-view board geometry).
 * Templates iterate these; data/clicks convert with toLogicalPoint / toDisplayPoint.
 */
export const DISPLAY_TOP_POINTS = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24] as const;
export const DISPLAY_BOTTOM_POINTS = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1] as const;

export function perspectiveFromSeat(seat: NardiPlayerIndex | null | undefined): BoardPerspective {
  // Spectators / unknown → canonical white view.
  return seat === 1 ? 'black' : 'white';
}

/** Invert a board point across the table. BAR / OFF are identity. */
export function invertPoint(point: number): number {
  if (point === BAR_POINT || point === OFF_POINT) return point;
  if (point >= 1 && point <= 24) return 25 - point;
  return point;
}

/**
 * Canonical logical → white-view display slot.
 * White: identity. Black: 25 − point (BAR/OFF unchanged).
 */
export function toDisplayPoint(logicalPoint: number, perspective: BoardPerspective): number {
  return perspective === 'white' ? logicalPoint : invertPoint(logicalPoint);
}

/**
 * White-view display slot → canonical logical point.
 * Inverse of {@link toDisplayPoint}.
 */
export function toLogicalPoint(displayPoint: number, perspective: BoardPerspective): number {
  return perspective === 'white' ? displayPoint : invertPoint(displayPoint);
}

export interface PointRows {
  top: readonly number[];
  bottom: readonly number[];
}

/** Fixed display-slot rows (same screen geometry for both perspectives). */
export function displayPointRows(): PointRows {
  return { top: DISPLAY_TOP_POINTS, bottom: DISPLAY_BOTTOM_POINTS };
}

/**
 * Bar zone order top→bottom for the center strip.
 * Local player's bar checkers stay on the near (bottom) side.
 */
export function barPlayerOrder(perspective: BoardPerspective): [NardiPlayerIndex, NardiPlayerIndex] {
  // White view: p1 (far/top), p0 (near/bottom). Black view: swap.
  return perspective === 'black' ? [0, 1] : [1, 0];
}
