import {
  BAR_POINT,
  CHECKERS_PER_PLAYER,
  OFF_POINT,
  countAt,
  direction,
  entryPoint,
  homeBoardEnd,
  homeBoardStart,
  ownerAt,
  type NardiBoardState,
  type NardiMove,
  type NardiPlayerIndex,
} from './types.js';

function cloneBoard(board: NardiBoardState): NardiBoardState {
  return {
    points: [...board.points],
    bar: [...board.bar] as [number, number],
    off: [...board.off] as [number, number],
  };
}

export function allCheckersInHome(board: NardiBoardState, player: NardiPlayerIndex): boolean {
  if (board.bar[player] > 0) return false;
  const sign = player === 0 ? 1 : -1;
  for (let p = 1; p <= 24; p++) {
    const v = board.points[p] ?? 0;
    if (v * sign <= 0) continue;
    if (p < homeBoardStart(player) || p > homeBoardEnd(player)) {
      return false;
    }
  }
  return true;
}

export function hasWon(board: NardiBoardState, player: NardiPlayerIndex): boolean {
  return board.off[player] >= CHECKERS_PER_PLAYER;
}

function isBlocked(board: NardiBoardState, player: NardiPlayerIndex, point: number): boolean {
  const owner = ownerAt(board.points, point);
  if (owner === null || owner === player) return false;
  return countAt(board.points, point) >= 2;
}

function canLand(board: NardiBoardState, player: NardiPlayerIndex, point: number): boolean {
  if (point < 1 || point > 24) return false;
  return !isBlocked(board, player, point);
}

function isHit(board: NardiBoardState, player: NardiPlayerIndex, point: number): boolean {
  const owner = ownerAt(board.points, point);
  return owner !== null && owner !== player && countAt(board.points, point) === 1;
}

/**
 * Highest point (furthest from off) occupied by player in home board.
 * Used for bearing-off exact/over rules.
 */
function highestHomePoint(board: NardiBoardState, player: NardiPlayerIndex): number {
  const sign = player === 0 ? 1 : -1;
  if (player === 0) {
    for (let p = 6; p >= 1; p--) {
      if ((board.points[p] ?? 0) * sign > 0) return p;
    }
  } else {
    for (let p = 19; p <= 24; p++) {
      if ((board.points[p] ?? 0) * sign > 0) return p;
    }
  }
  return 0;
}

function pipDistanceToOff(player: NardiPlayerIndex, from: number): number {
  return player === 0 ? from : 25 - from;
}

function canBearOff(
  board: NardiBoardState,
  player: NardiPlayerIndex,
  from: number,
  die: number,
): boolean {
  if (!allCheckersInHome(board, player)) return false;
  const distance = pipDistanceToOff(player, from);
  if (distance === die) return true;
  if (die > distance) {
    // May bear off with higher die only from the highest occupied home point
    return from === highestHomePoint(board, player);
  }
  return false;
}

/** Apply a validated move; returns new board (does not mutate). */
export function applyMove(board: NardiBoardState, player: NardiPlayerIndex, move: NardiMove): NardiBoardState {
  const next = cloneBoard(board);
  const sign = player === 0 ? 1 : -1;

  if (move.from === BAR_POINT) {
    if (next.bar[player] <= 0) {
      throw new Error('No checker on bar');
    }
    next.bar[player] -= 1;
  } else {
    const v = next.points[move.from] ?? 0;
    if (v * sign <= 0) {
      throw new Error('No player checker at source');
    }
    next.points[move.from] = v - sign;
  }

  if (move.to === OFF_POINT) {
    next.off[player] += 1;
  } else {
    if (move.hit) {
      const opponent: NardiPlayerIndex = player === 0 ? 1 : 0;
      next.points[move.to] = 0;
      next.bar[opponent] += 1;
    }
    next.points[move.to] = (next.points[move.to] ?? 0) + sign;
  }

  return next;
}

/** Enumerate legal moves for a single die value. */
export function legalMovesForDie(
  board: NardiBoardState,
  player: NardiPlayerIndex,
  die: number,
): NardiMove[] {
  const moves: NardiMove[] = [];
  const dir = direction(player);

  // Must enter from bar first
  if (board.bar[player] > 0) {
    const to = entryPoint(player, die);
    if (canLand(board, player, to)) {
      moves.push({
        from: BAR_POINT,
        to,
        die,
        hit: isHit(board, player, to),
      });
    }
    return moves;
  }

  const sign = player === 0 ? 1 : -1;
  for (let from = 1; from <= 24; from++) {
    if ((board.points[from] ?? 0) * sign <= 0) continue;

    if (canBearOff(board, player, from, die)) {
      moves.push({ from, to: OFF_POINT, die, hit: false });
      continue;
    }

    const to = from + dir * die;
    if (to < 1 || to > 24) continue;
    if (!canLand(board, player, to)) continue;

    moves.push({
      from,
      to,
      die,
      hit: isHit(board, player, to),
    });
  }

  return moves;
}

/**
 * All legal moves given remaining dice values.
 * Deduplicates identical from/to pairs preferring any valid die.
 */
export function computeLegalMoves(
  board: NardiBoardState,
  player: NardiPlayerIndex,
  remaining: number[],
): NardiMove[] {
  const uniqueDice = [...new Set(remaining)];
  const seen = new Set<string>();
  const result: NardiMove[] = [];

  for (const die of uniqueDice) {
    for (const move of legalMovesForDie(board, player, die)) {
      const key = `${move.from}->${move.to}:${move.die}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(move);
    }
  }

  return result;
}

export function findMatchingMove(
  legal: NardiMove[],
  from: number,
  to: number,
): NardiMove | undefined {
  const fromN = Number(from);
  const toN = Number(to);
  return legal.find((m) => m.from === fromN && m.to === toN);
}

/** Remove one occurrence of die from remaining. */
export function consumeDie(remaining: number[], die: number): number[] {
  const idx = remaining.indexOf(die);
  if (idx === -1) {
    throw new Error(`Die ${die} not in remaining`);
  }
  return [...remaining.slice(0, idx), ...remaining.slice(idx + 1)];
}
