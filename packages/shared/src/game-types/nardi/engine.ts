import { NardiPhase } from '../../enums/index.js';
import {
  applyMove,
  computeLegalMoves,
  consumeDie,
  findMatchingMove,
  hasWon,
} from './rules.js';
import {
  createEmptyNardiState,
  createInitialBoard,
  createInitialDice,
  type DiceState,
  type NardiGameState,
  type NardiMove,
  type NardiPlayerIndex,
  type NardiPlayerInfo,
} from './types.js';

export type RandomIntFn = (minInclusive: number, maxInclusive: number) => number;

export interface RollDiceResult {
  ok: true;
  state: NardiGameState;
  dice: [number, number];
}

export interface MoveResult {
  ok: true;
  state: NardiGameState;
  move: NardiMove;
  turnedEnded: boolean;
  winner: NardiPlayerIndex | null;
}

export interface ActionError {
  ok: false;
  code:
    | 'NOT_YOUR_TURN'
    | 'INVALID_PHASE'
    | 'ALREADY_ROLLED'
    | 'INVALID_MOVE'
    | 'NO_LEGAL_MOVES'
    | 'GAME_OVER';
  message: string;
}

function expandDice(a: number, b: number): number[] {
  if (a === b) {
    return [a, a, a, a];
  }
  return [a, b];
}

/**
 * Pure Nardi / backgammon engine.
 * Server injects a cryptographically secure randomInt.
 * Tests inject a deterministic RNG.
 */
export class NardiEngine {
  constructor(private readonly randomInt: RandomIntFn) {}

  static createInitialState(
    players: [NardiPlayerInfo, NardiPlayerInfo],
    firstPlayer: NardiPlayerIndex = 0,
  ): NardiGameState {
    return {
      players,
      board: createInitialBoard(),
      currentTurn: firstPlayer,
      dice: createInitialDice(),
      phase: NardiPhase.WAITING_FOR_ROLL,
      winner: null,
      moveHistory: [],
      legalMoves: [],
      turnNumber: 1,
    };
  }

  static empty(): NardiGameState {
    return createEmptyNardiState();
  }

  rollDice(state: NardiGameState, player: NardiPlayerIndex): RollDiceResult | ActionError {
    if (state.winner !== null || state.phase === NardiPhase.GAME_OVER) {
      return { ok: false, code: 'GAME_OVER', message: 'Game is already over' };
    }
    if (state.currentTurn !== player) {
      return { ok: false, code: 'NOT_YOUR_TURN', message: 'It is not your turn' };
    }
    if (state.phase !== NardiPhase.WAITING_FOR_ROLL) {
      return { ok: false, code: 'INVALID_PHASE', message: 'Cannot roll in current phase' };
    }
    if (state.dice.rolled) {
      return { ok: false, code: 'ALREADY_ROLLED', message: 'Dice already rolled this turn' };
    }

    const d1 = this.randomInt(1, 6);
    const d2 = this.randomInt(1, 6);
    const values: [number, number] = [d1, d2];
    const remaining = expandDice(d1, d2);
    const legalMoves = computeLegalMoves(state.board, player, remaining);

    const dice: DiceState = { values, remaining, rolled: true };

    if (legalMoves.length === 0) {
      // No moves — turn passes after roll
      const nextTurn: NardiPlayerIndex = player === 0 ? 1 : 0;
      return {
        ok: true,
        dice: values,
        state: {
          ...state,
          dice: { values, remaining: [], rolled: false },
          legalMoves: [],
          currentTurn: nextTurn,
          phase: NardiPhase.WAITING_FOR_ROLL,
          turnNumber: state.turnNumber + 1,
        },
      };
    }

    return {
      ok: true,
      dice: values,
      state: {
        ...state,
        dice,
        legalMoves,
        phase: NardiPhase.WAITING_FOR_MOVE,
      },
    };
  }

  moveChecker(
    state: NardiGameState,
    player: NardiPlayerIndex,
    from: number,
    to: number,
  ): MoveResult | ActionError {
    if (state.winner !== null || state.phase === NardiPhase.GAME_OVER) {
      return { ok: false, code: 'GAME_OVER', message: 'Game is already over' };
    }
    if (state.currentTurn !== player) {
      return { ok: false, code: 'NOT_YOUR_TURN', message: 'It is not your turn' };
    }
    if (state.phase !== NardiPhase.WAITING_FOR_MOVE) {
      return { ok: false, code: 'INVALID_PHASE', message: 'Must roll before moving' };
    }

    const move = findMatchingMove(state.legalMoves, from, to);
    if (!move) {
      return { ok: false, code: 'INVALID_MOVE', message: 'Illegal move' };
    }

    const board = applyMove(state.board, player, move);
    const remaining = consumeDie(state.dice.remaining, move.die);
    const moveHistory = [...state.moveHistory, move];

    if (hasWon(board, player)) {
      return {
        ok: true,
        move,
        turnedEnded: true,
        winner: player,
        state: {
          ...state,
          board,
          dice: { ...state.dice, remaining: [] },
          legalMoves: [],
          moveHistory,
          phase: NardiPhase.GAME_OVER,
          winner: player,
        },
      };
    }

    if (remaining.length === 0) {
      const nextTurn: NardiPlayerIndex = player === 0 ? 1 : 0;
      return {
        ok: true,
        move,
        turnedEnded: true,
        winner: null,
        state: {
          ...state,
          board,
          dice: createInitialDice(),
          legalMoves: [],
          moveHistory,
          currentTurn: nextTurn,
          phase: NardiPhase.WAITING_FOR_ROLL,
          turnNumber: state.turnNumber + 1,
        },
      };
    }

    const legalMoves = computeLegalMoves(board, player, remaining);
    if (legalMoves.length === 0) {
      // Remaining dice unusable — end turn
      const nextTurn: NardiPlayerIndex = player === 0 ? 1 : 0;
      return {
        ok: true,
        move,
        turnedEnded: true,
        winner: null,
        state: {
          ...state,
          board,
          dice: createInitialDice(),
          legalMoves: [],
          moveHistory,
          currentTurn: nextTurn,
          phase: NardiPhase.WAITING_FOR_ROLL,
          turnNumber: state.turnNumber + 1,
        },
      };
    }

    return {
      ok: true,
      move,
      turnedEnded: false,
      winner: null,
      state: {
        ...state,
        board,
        dice: { ...state.dice, remaining },
        legalMoves,
        moveHistory,
        phase: NardiPhase.WAITING_FOR_MOVE,
      },
    };
  }

  /** Explicit pass when no legal moves remain after a roll (normally auto-handled). */
  pass(state: NardiGameState, player: NardiPlayerIndex): MoveResult | ActionError {
    if (state.currentTurn !== player) {
      return { ok: false, code: 'NOT_YOUR_TURN', message: 'It is not your turn' };
    }
    if (state.phase !== NardiPhase.WAITING_FOR_MOVE) {
      return { ok: false, code: 'INVALID_PHASE', message: 'Nothing to pass' };
    }
    if (state.legalMoves.length > 0) {
      return { ok: false, code: 'INVALID_MOVE', message: 'Legal moves remain' };
    }
    const nextTurn: NardiPlayerIndex = player === 0 ? 1 : 0;
    return {
      ok: true,
      move: { from: -1, to: -1, die: 0, hit: false },
      turnedEnded: true,
      winner: null,
      state: {
        ...state,
        dice: createInitialDice(),
        legalMoves: [],
        currentTurn: nextTurn,
        phase: NardiPhase.WAITING_FOR_ROLL,
        turnNumber: state.turnNumber + 1,
      },
    };
  }
}
