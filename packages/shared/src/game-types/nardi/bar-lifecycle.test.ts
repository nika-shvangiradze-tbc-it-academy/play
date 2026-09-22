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
  createInitialBoard,
  entryPoint,
  getBarEntryPoint,
  type NardiBoardState,
  type NardiPlayerInfo,
} from './types.js';

function players(): [NardiPlayerInfo, NardiPlayerInfo] {
  return [
    { userId: 'u1', username: 'alice', seat: 0, connected: true, reconnectDeadline: null },
    { userId: 'u2', username: 'bob', seat: 1, connected: true, reconnectDeadline: null },
  ];
}

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

function emptyBoard(): NardiBoardState {
  return {
    points: new Array(25).fill(0),
    bar: [0, 0],
    off: [0, 0],
  };
}

function totalCheckers(board: NardiBoardState): { white: number; black: number } {
  let white = board.bar[0] + board.off[0];
  let black = board.bar[1] + board.off[1];
  for (let p = 1; p <= 24; p++) {
    const v = board.points[p] ?? 0;
    if (v > 0) white += v;
    if (v < 0) black += -v;
  }
  return { white, black };
}

describe('bar entry-point mapping', () => {
  it('maps White die 1–6 to canonical points 24–19', () => {
    for (let die = 1; die <= 6; die++) {
      expect(getBarEntryPoint(0, die)).toBe(25 - die);
      expect(entryPoint(0, die)).toBe(25 - die);
    }
    expect([1, 2, 3, 4, 5, 6].map((d) => getBarEntryPoint(0, d))).toEqual([
      24, 23, 22, 21, 20, 19,
    ]);
  });

  it('maps Dark die 1–6 to canonical points 1–6', () => {
    for (let die = 1; die <= 6; die++) {
      expect(getBarEntryPoint(1, die)).toBe(die);
      expect(entryPoint(1, die)).toBe(die);
    }
    expect([1, 2, 3, 4, 5, 6].map((d) => getBarEntryPoint(1, d))).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });
});

describe('hit → bar persistence', () => {
  it('sends hit blot to the correct opponent bar and preserves totals', () => {
    const board = createInitialBoard();
    board.points[5] = -1;
    const before = totalCheckers(board);
    const next = applyMove(board, 0, { from: 8, to: 5, die: 3, hit: false });
    expect(next.points[5]).toBe(1);
    expect(next.bar[1]).toBe(1);
    expect(totalCheckers(next)).toEqual(before);
  });

  it('keeps bar count in authoritative state after hit', () => {
    const board = emptyBoard();
    board.points[8] = 1;
    board.points[5] = -1;
    board.points[24] = 14;
    board.points[1] = -14;
    const next = applyMove(board, 0, { from: 8, to: 5, die: 3, hit: true });
    expect(next.bar).toEqual([0, 1]);
    expect(next.points[5]).toBe(1);
  });
});

describe('bar absolute move priority', () => {
  it('generates ONLY bar-entry moves while white barCount > 0', () => {
    const board = createInitialBoard();
    board.bar[0] = 1;
    board.points[24] = 1;
    const moves = computeLegalMoves(board, 0, [1, 2, 3, 4, 5, 6]);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((m) => m.from === BAR_POINT)).toBe(true);
  });

  it('generates ONLY bar-entry moves while dark barCount > 0', () => {
    const board = createInitialBoard();
    board.bar[1] = 1;
    board.points[1] = -1;
    const moves = computeLegalMoves(board, 1, [1, 2, 3, 4, 5, 6]);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((m) => m.from === BAR_POINT)).toBe(true);
  });

  it('still allows rolling while on the bar (phase WAITING_FOR_ROLL)', () => {
    const engine = new NardiEngine(queueRng([3, 5]));
    let state = NardiEngine.createInitialState(players(), 0);
    const board = createInitialBoard();
    board.bar[0] = 1;
    board.points[24] = 1;
    state = { ...state, board, phase: NardiPhase.WAITING_FOR_ROLL };
    const rolled = engine.rollDice(state, 0);
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    expect(rolled.state.dice.rolled).toBe(true);
    expect(rolled.state.legalMoves.every((m) => m.from === BAR_POINT)).toBe(true);
  });
});

describe('bar entry legality', () => {
  it('allows empty entry point', () => {
    const board = emptyBoard();
    board.bar[0] = 1;
    board.points[24] = 0;
    const moves = legalMovesForDie(board, 0, 1);
    expect(moves).toEqual([{ from: BAR_POINT, to: 24, die: 1, hit: false }]);
  });

  it('allows own occupied entry point', () => {
    const board = emptyBoard();
    board.bar[0] = 1;
    board.points[24] = 2;
    const moves = legalMovesForDie(board, 0, 1);
    expect(moves.some((m) => m.to === 24 && !m.hit)).toBe(true);
  });

  it('allows opponent blot and marks hit', () => {
    const board = emptyBoard();
    board.bar[0] = 1;
    board.points[22] = -1;
    const moves = legalMovesForDie(board, 0, 3);
    expect(moves).toEqual([{ from: BAR_POINT, to: 22, die: 3, hit: true }]);
  });

  it('blocks entry onto 2+ opponent checkers', () => {
    const board = emptyBoard();
    board.bar[0] = 1;
    board.points[22] = -2;
    expect(legalMovesForDie(board, 0, 3)).toEqual([]);
  });

  it('blocks entry onto 3+ opponent checkers', () => {
    const board = emptyBoard();
    board.bar[1] = 1;
    board.points[4] = 3;
    expect(legalMovesForDie(board, 1, 4)).toEqual([]);
  });
});

describe('partial / blocked / multi bar entry via engine', () => {
  it('one die blocked / one available → enter with open die', () => {
    const engine = new NardiEngine(queueRng([3, 5]));
    let state = NardiEngine.createInitialState(players(), 0);
    const board = emptyBoard();
    board.bar[0] = 1;
    board.points[13] = 14;
    board.points[1] = -15;
    // White entries: die3→22 blocked, die5→20 open
    board.points[22] = -2;
    board.points[20] = 0;
    state = { ...state, board };

    const rolled = engine.rollDice(state, 0);
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    expect(rolled.state.legalMoves.map((m) => m.die).sort()).toEqual([5]);
    expect(rolled.state.legalMoves.every((m) => m.from === BAR_POINT)).toBe(true);

    const enter = rolled.state.legalMoves[0]!;
    const moved = engine.moveChecker(rolled.state, 0, enter.from, enter.to);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.state.board.bar[0]).toBe(0);
    expect(moved.state.board.points[20]).toBe(1);
  });

  it('both dice blocked → automatic turn pass after roll', () => {
    const engine = new NardiEngine(queueRng([2, 4]));
    let state = NardiEngine.createInitialState(players(), 0);
    const board = emptyBoard();
    board.bar[0] = 1;
    board.points[13] = 14;
    for (let p = 19; p <= 24; p++) board.points[p] = -2;
    state = { ...state, board };

    const rolled = engine.rollDice(state, 0);
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    expect(rolled.state.phase).toBe(NardiPhase.WAITING_FOR_ROLL);
    expect(rolled.state.currentTurn).toBe(1);
    expect(rolled.state.dice.rolled).toBe(false);
    expect(rolled.state.board.bar[0]).toBe(1);
    expect(rolled.state.legalMoves).toEqual([]);
  });

  it('both dice available for bar entry', () => {
    const board = emptyBoard();
    board.bar[0] = 1;
    const moves = computeLegalMoves(board, 0, [2, 5]);
    expect(moves.map((m) => m.to).sort((a, b) => a - b)).toEqual([20, 23]);
  });

  it('multiple bar checkers: enter one then remaining die blocked → turn ends', () => {
    const engine = new NardiEngine(queueRng([2, 5]));
    let state = NardiEngine.createInitialState(players(), 1);
    const board = emptyBoard();
    board.bar[1] = 2;
    board.points[24] = 15;
    // Dark entries: die2→2 open, die5→5 blocked
    board.points[2] = 0;
    board.points[5] = 2;
    state = { ...state, board, currentTurn: 1 };

    const rolled = engine.rollDice(state, 1);
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    expect(rolled.state.legalMoves.map((m) => m.die)).toEqual([2]);

    const enter = rolled.state.legalMoves[0]!;
    const moved = engine.moveChecker(rolled.state, 1, enter.from, enter.to);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.turnedEnded).toBe(true);
    expect(moved.state.board.bar[1]).toBe(1);
    expect(moved.state.phase).toBe(NardiPhase.WAITING_FOR_ROLL);
    expect(moved.state.currentTurn).toBe(0);
  });

  it('doubles with bar: successive entries until bar empty or blocked', () => {
    const engine = new NardiEngine(queueRng([4, 4]));
    let state = NardiEngine.createInitialState(players(), 0);
    const board = emptyBoard();
    board.bar[0] = 2;
    board.points[13] = 13;
    board.points[1] = -15;
    state = { ...state, board };

    const rolled = engine.rollDice(state, 0);
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    expect(rolled.state.dice.remaining).toEqual([4, 4, 4, 4]);
    expect(rolled.state.legalMoves.every((m) => m.from === BAR_POINT && m.to === 21)).toBe(true);

    const first = engine.moveChecker(rolled.state, 0, BAR_POINT, 21);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.state.board.bar[0]).toBe(1);
    expect(first.state.legalMoves.every((m) => m.from === BAR_POINT)).toBe(true);

    const second = engine.moveChecker(first.state, 0, BAR_POINT, 21);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.state.board.bar[0]).toBe(0);
    // Remaining dice may produce normal moves; must not stay on bar-only.
    expect(second.state.board.bar[0]).toBe(0);
  });

  it('hit-on-entry decrements own bar and increments opponent bar once', () => {
    const engine = new NardiEngine(queueRng([3, 1]));
    let state = NardiEngine.createInitialState(players(), 0);
    const board = emptyBoard();
    board.bar[0] = 1;
    board.points[13] = 14;
    board.points[22] = -1; // blot on white die-3 entry
    board.points[1] = -14;
    state = { ...state, board };

    const rolled = engine.rollDice(state, 0);
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    const enter = rolled.state.legalMoves.find((m) => m.die === 3 && m.hit);
    expect(enter).toBeDefined();
    if (!enter) return;

    const moved = engine.moveChecker(rolled.state, 0, enter.from, enter.to);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.state.board.bar[0]).toBe(0);
    expect(moved.state.board.bar[1]).toBe(1);
    expect(moved.state.board.points[22]).toBe(1);
    expect(totalCheckers(moved.state.board)).toEqual({ white: 15, black: 15 });
  });

  it('successful entry decrements bar count exactly once', () => {
    const board = emptyBoard();
    board.bar[1] = 2;
    const next = applyMove(board, 1, { from: BAR_POINT, to: 3, die: 3, hit: false });
    expect(next.bar[1]).toBe(1);
    expect(next.points[3]).toBe(-1);
  });
});

describe('bar progress invariant (anti-stuck)', () => {
  it('never leaves an unfinished game without roll / move / auto-pass', () => {
    let s = 99;
    const rng = (min: number, max: number) => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return min + (s % (max - min + 1));
    };
    const engine = new NardiEngine(rng);
    let state = NardiEngine.createInitialState(players(), 0);

    // Seed frequent hits by starting with both players having bar pressure positions.
    const board = createInitialBoard();
    board.points[5] = -1;
    board.points[20] = 1;
    state = { ...state, board };

    for (let step = 0; step < 1200 && state.phase !== NardiPhase.GAME_OVER; step++) {
      state = NardiEngine.ensureProgressable(state);
      if (state.winner !== null) break;

      if (state.phase === NardiPhase.WAITING_FOR_ROLL) {
        expect(state.dice.rolled).toBe(false);
        expect(state.legalMoves).toEqual([]);
        const r = engine.rollDice(state, state.currentTurn);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        state = NardiEngine.ensureProgressable(r.state);
        // After roll: either moving with ≥1 legal move, or turn already passed.
        if (state.phase === NardiPhase.WAITING_FOR_MOVE) {
          expect(state.legalMoves.length).toBeGreaterThan(0);
          if (state.board.bar[state.currentTurn] > 0) {
            expect(state.legalMoves.every((m) => m.from === BAR_POINT)).toBe(true);
          }
        } else {
          expect(state.phase).toBe(NardiPhase.WAITING_FOR_ROLL);
          expect(state.dice.rolled).toBe(false);
        }
        continue;
      }

      if (state.phase === NardiPhase.WAITING_FOR_MOVE) {
        expect(state.legalMoves.length).toBeGreaterThan(0);
        const m = state.legalMoves[rng(0, state.legalMoves.length - 1)]!;
        if (state.board.bar[state.currentTurn] > 0) {
          expect(m.from).toBe(BAR_POINT);
        }
        const r = engine.moveChecker(state, state.currentTurn, m.from, m.to);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        state = NardiEngine.ensureProgressable(r.state);
        continue;
      }

      throw new Error(`Dead-end phase ${state.phase}`);
    }
  });

  it('reconnect-style ensureProgressable restores bar entry legal moves', () => {
    let state = NardiEngine.createInitialState(players(), 0);
    const board = emptyBoard();
    board.bar[0] = 1;
    board.points[13] = 14;
    board.points[1] = -15;
    state = {
      ...state,
      board,
      phase: NardiPhase.WAITING_FOR_MOVE,
      dice: { values: [2, 5], remaining: [2, 5], rolled: true },
      legalMoves: [], // stale after refresh
    };
    const healed = NardiEngine.ensureProgressable(state);
    expect(healed.phase).toBe(NardiPhase.WAITING_FOR_MOVE);
    expect(healed.board.bar[0]).toBe(1);
    expect(healed.legalMoves.length).toBeGreaterThan(0);
    expect(healed.legalMoves.every((m) => m.from === BAR_POINT)).toBe(true);
  });
});
