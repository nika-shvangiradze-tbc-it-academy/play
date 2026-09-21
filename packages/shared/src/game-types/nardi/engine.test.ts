import { describe, expect, it } from 'vitest';
import { NardiPhase } from '../../enums/index.js';
import { NardiEngine } from './engine.js';
import {
  applyMove,
  computeLegalMoves,
  legalMovesForDie,
} from './rules.js';
import {
  BAR_POINT,
  OFF_POINT,
  createInitialBoard,
  type NardiPlayerInfo,
} from './types.js';

function players(): [NardiPlayerInfo, NardiPlayerInfo] {
  return [
    { userId: 'u1', username: 'alice', seat: 0, connected: true, reconnectDeadline: null },
    { userId: 'u2', username: 'bob', seat: 1, connected: true, reconnectDeadline: null },
  ];
}

/** Deterministic RNG from a queue of values. */
function queueRng(values: number[]) {
  let i = 0;
  return (min: number, max: number) => {
    const v = values[i++] ?? min;
    if (v < min || v > max) {
      throw new Error(`Queued RNG value ${v} out of range ${min}-${max}`);
    }
    return v;
  };
}

describe('Nardi starting position', () => {
  it('places 15 checkers per side', () => {
    const board = createInitialBoard();
    let white = board.bar[0] + board.off[0];
    let black = board.bar[1] + board.off[1];
    for (let p = 1; p <= 24; p++) {
      const v = board.points[p] ?? 0;
      if (v > 0) white += v;
      if (v < 0) black += -v;
    }
    expect(white).toBe(15);
    expect(black).toBe(15);
  });
});

describe('dice & turn validation', () => {
  it('rolls dice server-side and expands doubles', () => {
    const engine = new NardiEngine(queueRng([6, 6]));
    let state = NardiEngine.createInitialState(players(), 0);
    const result = engine.rollDice(state, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dice).toEqual([6, 6]);
    expect(result.state.dice.remaining).toEqual([6, 6, 6, 6]);
    expect(result.state.phase).toBe(NardiPhase.WAITING_FOR_MOVE);
  });

  it('rejects double roll', () => {
    const engine = new NardiEngine(queueRng([3, 5]));
    let state = NardiEngine.createInitialState(players(), 0);
    const first = engine.rollDice(state, 0);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = engine.rollDice(first.state, 0);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('INVALID_PHASE');
  });

  it('rejects roll when not player turn', () => {
    const engine = new NardiEngine(queueRng([2, 3]));
    const state = NardiEngine.createInitialState(players(), 0);
    const result = engine.rollDice(state, 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NOT_YOUR_TURN');
  });
});

describe('legal moves', () => {
  it('computes opening moves for a 3-roll from point 8', () => {
    const board = createInitialBoard();
    const moves = legalMovesForDie(board, 0, 3);
    expect(moves.some((m) => m.from === 8 && m.to === 5)).toBe(true);
  });

  it('rejects illegal move', () => {
    const engine = new NardiEngine(queueRng([1, 2]));
    let state = NardiEngine.createInitialState(players(), 0);
    const rolled = engine.rollDice(state, 0);
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    const bad = engine.moveChecker(rolled.state, 0, 24, 1);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe('INVALID_MOVE');
  });

  it('applies a legal move and consumes die', () => {
    const engine = new NardiEngine(queueRng([1, 2]));
    let state = NardiEngine.createInitialState(players(), 0);
    const rolled = engine.rollDice(state, 0);
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    const legal = rolled.state.legalMoves[0];
    expect(legal).toBeDefined();
    if (!legal) return;
    const moved = engine.moveChecker(rolled.state, 0, legal.from, legal.to);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.state.dice.remaining.length).toBe(1);
  });
});

describe('bar entry & hits', () => {
  it('requires bar entry before other moves', () => {
    const board = createInitialBoard();
    board.bar[0] = 1;
    board.points[24] = 1; // one left on 24 after hypothetical hit setup
    const moves = computeLegalMoves(board, 0, [1]);
    expect(moves.every((m) => m.from === BAR_POINT)).toBe(true);
    expect(moves.some((m) => m.to === 24)).toBe(true);
  });

  it('hits a blot and sends opponent to bar', () => {
    const board = createInitialBoard();
    // Clear point 5 and put a single black blot
    board.points[5] = -1;
    const move = { from: 8, to: 5, die: 3, hit: true };
    const next = applyMove(board, 0, move);
    expect(next.points[5]).toBe(1);
    expect(next.bar[1]).toBe(1);
  });
});

describe('winning condition', () => {
  it('detects win when 15 checkers are off', () => {
    const engine = new NardiEngine(queueRng([6, 6, 6, 6, 6, 6]));
    let state = NardiEngine.createInitialState(players(), 0);
    // Force almost-won board: all white off except one on point 6, empty elsewhere for white
    state = {
      ...state,
      board: {
        points: new Array(25).fill(0),
        bar: [0, 0],
        off: [14, 0],
      },
      phase: NardiPhase.WAITING_FOR_ROLL,
    };
    state.board.points[6] = 1;
    // Opponent pieces parked safely
    state.board.points[24] = -15;

    const rolled = engine.rollDice(state, 0);
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    const bear = rolled.state.legalMoves.find((m) => m.from === 6 && m.to === OFF_POINT);
    expect(bear).toBeDefined();
    if (!bear) return;
    const moved = engine.moveChecker(rolled.state, 0, bear.from, bear.to);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.winner).toBe(0);
    expect(moved.state.phase).toBe(NardiPhase.GAME_OVER);
  });
});
