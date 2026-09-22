/**
 * Nardi/backgammon board geometry — single source of truth for responsive layout.
 * All sizes are CSS pixels. Pure functions; safe to unit-test.
 */

/** Classic board width ÷ height (playing table, not including chrome). */
export const BOARD_ASPECT = 1.78;

/** Max discs drawn in a stack before collapsing into a count badge. */
export const MAX_VISIBLE_CHECKERS = 8;

export interface BoardGeometry {
  boardWidth: number;
  boardHeight: number;
  framePadding: number;
  barWidth: number;
  playingWidth: number;
  playingHeight: number;
  quadrantWidth: number;
  pointWidth: number;
  /** Usable triangle height (one half of the board, minus mid-gap). */
  pointHeight: number;
  /** Reserved strip for pip numbers at the tip of each point. */
  pipReserve: number;
  /** Height available for checker stack (excludes pip reserve + edge pad). */
  stackHeight: number;
  /** Checker diameter from point width (with horizontal safety margin). */
  checkerSize: number;
  dieSize: number;
}

export interface StackLayout {
  /** Checkers to render (may be < count when extreme). */
  visible: number;
  /** Distance between consecutive checker top/bottom edges. */
  step: number;
  /** Checker diameter (same as board checkerSize). */
  size: number;
  /** Total count badge when stacked past a readable threshold or clipped. */
  badge: number;
}

export interface FitBoardInput {
  stageWidth: number;
  stageHeight: number;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Largest board that fits in the stage while preserving aspect ratio. */
export function fitBoardSize(input: FitBoardInput): { width: number; height: number } {
  const wAvail = Math.max(0, input.stageWidth);
  const hAvail = Math.max(0, input.stageHeight);
  if (wAvail <= 0 || hAvail <= 0) {
    return { width: 0, height: 0 };
  }

  let width = wAvail;
  let height = width / BOARD_ASPECT;
  if (height > hAvail) {
    height = hAvail;
    width = height * BOARD_ASPECT;
  }
  return {
    width: Math.floor(width * 100) / 100,
    height: Math.floor(height * 100) / 100,
  };
}

/**
 * Derive all board tokens from outer frame size.
 * Frame size is the .board-frame box (includes wooden padding).
 */
export function computeBoardGeometry(boardWidth: number, boardHeight: number): BoardGeometry {
  const w = Math.max(0, boardWidth);
  const h = Math.max(0, boardHeight);

  const framePadding = clamp(w * 0.016, 4, 18);
  const barWidth = clamp(w * 0.052, 22, 72);

  const playingWidth = Math.max(0, w - framePadding * 2);
  const playingHeight = Math.max(0, h - framePadding * 2);
  const quadrantWidth = Math.max(0, (playingWidth - barWidth) / 2);
  const pointWidth = quadrantWidth / 6;

  const halfHeight = playingHeight / 2;
  const pointHeight = halfHeight * 0.96;
  const pipReserve = clamp(pointHeight * 0.1, 9, 18);
  const edgePad = clamp(pointHeight * 0.02, 1, 4);
  const stackHeight = Math.max(pointHeight - pipReserve - edgePad, pointWidth);

  // Horizontal inset so neighboring columns / bar never collide.
  const checkerSize = clamp(pointWidth * 0.7, 11, 42);
  const dieSize = clamp(Math.min(pointWidth * 1.35, playingHeight * 0.12), 22, 56);

  return {
    boardWidth: w,
    boardHeight: h,
    framePadding,
    barWidth,
    playingWidth,
    playingHeight,
    quadrantWidth,
    pointWidth,
    pointHeight,
    pipReserve,
    stackHeight,
    checkerSize,
    dieSize,
  };
}

/**
 * Stack layout: keep checker diameter fixed; compress step only when needed.
 *
 * totalHeight = size + (visible - 1) * step  ≤  stackHeight
 */
export function computeStackLayout(
  count: number,
  checkerSize: number,
  stackHeight: number,
): StackLayout {
  const size = Math.max(1, checkerSize);
  const avail = Math.max(size, stackHeight);
  const n = Math.max(0, Math.floor(count));

  if (n <= 0) return { visible: 0, step: 0, size, badge: 0 };
  if (n === 1) return { visible: 1, step: 0, size, badge: 0 };

  const preferredGap = Math.max(2, size * 0.1);
  const preferredStep = size + preferredGap;
  /** Minimum center-offset that still shows a distinct rim of each disc. */
  const minStep = size * 0.42;

  const maxByMinStep = Math.max(1, Math.floor((avail - size) / minStep) + 1);
  const visible = Math.min(n, maxByMinStep, MAX_VISIBLE_CHECKERS);

  let step: number;
  if (visible === 1) {
    step = 0;
  } else {
    const preferredTotal = size + (visible - 1) * preferredStep;
    if (preferredTotal <= avail) {
      step = preferredStep;
    } else {
      step = (avail - size) / (visible - 1);
    }
  }

  const badge = n > visible || n > 5 ? n : 0;
  return { visible, step, size, badge };
}

/** CSS custom properties for the board frame / playing field. */
export function geometryCssVars(geo: BoardGeometry): Record<string, string> {
  return {
    '--board-width': `${geo.boardWidth}px`,
    '--board-height': `${geo.boardHeight}px`,
    '--outer-frame': `${geo.framePadding}px`,
    '--bar-width': `${geo.barWidth}px`,
    '--playing-width': `${geo.playingWidth}px`,
    '--playing-height': `${geo.playingHeight}px`,
    '--quadrant-width': `${geo.quadrantWidth}px`,
    '--point-width': `${geo.pointWidth}px`,
    '--point-height': `${geo.pointHeight}px`,
    '--pip-reserve': `${geo.pipReserve}px`,
    '--stack-height': `${geo.stackHeight}px`,
    '--checker-size': `${geo.checkerSize}px`,
    '--die-size': `${geo.dieSize}px`,
  };
}

/** Per-stack CSS vars (diameter stays board-global; step is local). */
export function stackCssVars(layout: StackLayout): Record<string, string> {
  return {
    '--stack-size': `${layout.size}px`,
    '--stack-step': `${layout.step}px`,
    '--stack-visible': String(Math.max(layout.visible, 1)),
  };
}
