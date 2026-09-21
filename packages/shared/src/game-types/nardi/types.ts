import { NardiPhase } from '../../enums/index.js';

/** Player seat index: 0 = host/white (moves toward point 1), 1 = black (moves toward 24). */
export type NardiPlayerIndex = 0 | 1;

/**
 * Board points 1–24.
 * Positive values = player 0 checkers, negative = player 1 checkers.
 * Magnitude = count.
 */
export interface NardiBoardState {
  /** Indices 0 unused; 1–24 are points. */
  points: number[];
  bar: [number, number];
  off: [number, number];
}

export interface NardiPlayerInfo {
  userId: string;
  username: string;
  seat: NardiPlayerIndex;
  connected: boolean;
  reconnectDeadline: number | null;
}

export interface DiceState {
  /** Raw roll, e.g. [3, 5] or [6, 6]. */
  values: [number, number] | null;
  /** Remaining usable pip values (doubles expand to 4). */
  remaining: number[];
  rolled: boolean;
}

export interface NardiMove {
  from: number;
  to: number;
  /** Die value consumed. */
  die: number;
  hit: boolean;
}

export interface NardiGameState {
  players: [NardiPlayerInfo, NardiPlayerInfo] | [NardiPlayerInfo] | [];
  board: NardiBoardState;
  currentTurn: NardiPlayerIndex;
  dice: DiceState;
  phase: NardiPhase;
  winner: NardiPlayerIndex | null;
  moveHistory: NardiMove[];
  /** Legal moves for current remaining dice (computed server-side). */
  legalMoves: NardiMove[];
  turnNumber: number;
}

export const POINT_COUNT = 24;
export const CHECKERS_PER_PLAYER = 15;

/** Create empty bar/off and initial backgammon setup. */
export function createInitialBoard(): NardiBoardState {
  const points = new Array<number>(25).fill(0);
  // Player 0 (white) — positive
  points[24] = 2;
  points[13] = 5;
  points[8] = 3;
  points[6] = 5;
  // Player 1 (black) — negative
  points[1] = -2;
  points[12] = -5;
  points[17] = -3;
  points[19] = -5;

  return {
    points,
    bar: [0, 0],
    off: [0, 0],
  };
}

export function createInitialDice(): DiceState {
  return { values: null, remaining: [], rolled: false };
}

export function createEmptyNardiState(): NardiGameState {
  return {
    players: [],
    board: createInitialBoard(),
    currentTurn: 0,
    dice: createInitialDice(),
    phase: NardiPhase.WAITING_FOR_ROLL,
    winner: null,
    moveHistory: [],
    legalMoves: [],
    turnNumber: 1,
  };
}

export function ownerAt(points: number[], point: number): NardiPlayerIndex | null {
  const v = points[point] ?? 0;
  if (v > 0) return 0;
  if (v < 0) return 1;
  return null;
}

export function countAt(points: number[], point: number): number {
  return Math.abs(points[point] ?? 0);
}

export function direction(player: NardiPlayerIndex): 1 | -1 {
  return player === 0 ? -1 : 1;
}

/** Bar sentinel for move `from`. */
export const BAR_POINT = 0;
/** Bear-off sentinel for move `to`. */
export const OFF_POINT = 25;

export function homeBoardStart(player: NardiPlayerIndex): number {
  return player === 0 ? 1 : 19;
}

export function homeBoardEnd(player: NardiPlayerIndex): number {
  return player === 0 ? 6 : 24;
}

export function entryPoint(player: NardiPlayerIndex, die: number): number {
  // White enters from bar onto 25-die (24..19), black onto die (1..6)
  return player === 0 ? 25 - die : die;
}
