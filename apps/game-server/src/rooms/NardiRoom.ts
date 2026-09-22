import { type Client } from '@colyseus/core';
import { randomInt } from 'node:crypto';
import {
  ClientIntent,
  ErrorCode,
  GameType,
  MatchStatus,
  NardiEngine,
  NardiPhase,
  type ClientMessage,
  type NardiGameState,
  type NardiPlayerIndex,
  type NardiPlayerInfo,
} from '@georgian-games/shared';
import { BaseGameRoom, type PlayerSession } from './BaseGameRoom.js';
import { LegalMoveSchema } from './schema/GameRoomState.js';
import { isDev } from '../config/env.js';

export class NardiRoom extends BaseGameRoom {
  private engine = new NardiEngine((min, max) => randomInt(min, max + 1));
  private game: NardiGameState = NardiEngine.empty();

  getGameType(): GameType {
    return GameType.NARDI;
  }

  protected onMatchStart(): void {
    const seats = [...this.state.seats.values()].sort((a, b) => a.seatNumber - b.seatNumber);
    if (seats.length < 2) {
      throw new Error('Nardi requires 2 players');
    }

    const players: [NardiPlayerInfo, NardiPlayerInfo] = [
      {
        userId: seats[0]!.userId,
        username: seats[0]!.username,
        seat: 0,
        connected: true,
        reconnectDeadline: null,
      },
      {
        userId: seats[1]!.userId,
        username: seats[1]!.username,
        seat: 1,
        connected: true,
        reconnectDeadline: null,
      },
    ];

    this.game = NardiEngine.createInitialState(players, 0);
    this.syncBoardToState();
    if (isDev()) console.log('[nardi] match engine initialized');
  }

  protected async onGameIntent(
    client: Client,
    session: PlayerSession,
    message: ClientMessage,
  ): Promise<void> {
    if (this.state.phase !== 'PLAYING') {
      this.sendError(client, ErrorCode.INVALID_PHASE, 'Match not in progress');
      return;
    }

    const seat = session.seatNumber as NardiPlayerIndex;
    if (seat !== 0 && seat !== 1) {
      this.sendError(client, ErrorCode.FORBIDDEN, 'Invalid seat');
      return;
    }

    switch (message.type) {
      case ClientIntent.ROLL_DICE: {
        const result = this.engine.rollDice(this.game, seat);
        if (!result.ok) {
          this.sendError(client, this.mapCode(result.code), result.message);
          return;
        }
        this.game = NardiEngine.ensureProgressable(result.state);
        this.syncBoardToState();
        this.logTurnSnapshot('after-roll', seat);
        break;
      }
      case ClientIntent.MOVE_CHECKER: {
        const from = Number(message.from);
        const to = Number(message.to);
        const result = this.engine.moveChecker(this.game, seat, from, to);
        if (!result.ok) {
          this.sendError(client, this.mapCode(result.code), result.message);
          return;
        }
        this.game = NardiEngine.ensureProgressable(result.state);
        this.syncBoardToState();
        this.logTurnSnapshot('after-move', seat);
        if (result.winner !== null) {
          const winnerUserId = this.game.players[result.winner]?.userId ?? null;
          await this.finalizeMatch(winnerUserId, MatchStatus.COMPLETED, null);
        }
        break;
      }
      case ClientIntent.PASS: {
        const result = this.engine.pass(this.game, seat);
        if (!result.ok) {
          this.sendError(client, this.mapCode(result.code), result.message);
          return;
        }
        this.game = NardiEngine.ensureProgressable(result.state);
        this.syncBoardToState();
        this.logTurnSnapshot('after-pass', seat);
        break;
      }
      default:
        this.sendError(client, ErrorCode.INVALID_MOVE, 'Unknown intent');
    }
  }

  private syncBoardToState(): void {
    this.game = NardiEngine.ensureProgressable(this.game);
    const g = this.game;
    this.state.nardiPhase = g.phase;
    this.state.currentTurn = g.currentTurn;
    this.state.turnNumber = g.turnNumber;
    this.state.winnerSeat = g.winner ?? -1;

    this.state.points.clear();
    for (let i = 0; i <= 24; i++) {
      this.state.points.push(g.board.points[i] ?? 0);
    }
    this.state.bar0 = g.board.bar[0];
    this.state.bar1 = g.board.bar[1];
    this.state.off0 = g.board.off[0];
    this.state.off1 = g.board.off[1];

    this.state.dice.rolled = g.dice.rolled;
    this.state.dice.d1 = g.dice.values?.[0] ?? 0;
    this.state.dice.d2 = g.dice.values?.[1] ?? 0;
    this.state.dice.remaining.clear();
    for (const d of g.dice.remaining) {
      this.state.dice.remaining.push(d);
    }

    this.state.legalMoves.clear();
    for (const m of g.legalMoves) {
      const lm = new LegalMoveSchema();
      lm.from = m.from;
      lm.to = m.to;
      lm.die = m.die;
      lm.hit = m.hit;
      this.state.legalMoves.push(lm);
    }

    if (g.phase === NardiPhase.GAME_OVER) {
      this.state.nardiPhase = NardiPhase.GAME_OVER;
    }
  }

  private logTurnSnapshot(label: string, seat: NardiPlayerIndex): void {
    if (!isDev()) return;
    const g = this.game;
    console.log('[nardi:turn]', {
      label,
      seat,
      playerId: g.players[seat]?.userId ?? null,
      currentTurn: g.currentTurn,
      phase: g.phase,
      dice: g.dice.values,
      rolled: g.dice.rolled,
      remaining: g.dice.remaining,
      legalMoves: g.legalMoves.length,
      bar: g.board.bar,
      turnNumber: g.turnNumber,
      gameOver: g.phase === NardiPhase.GAME_OVER,
    });
  }

  private mapCode(
    code:
      | 'NOT_YOUR_TURN'
      | 'INVALID_PHASE'
      | 'ALREADY_ROLLED'
      | 'INVALID_MOVE'
      | 'NO_LEGAL_MOVES'
      | 'GAME_OVER',
  ): ErrorCode {
    switch (code) {
      case 'NOT_YOUR_TURN':
        return ErrorCode.NOT_YOUR_TURN;
      case 'INVALID_PHASE':
        return ErrorCode.INVALID_PHASE;
      case 'ALREADY_ROLLED':
        return ErrorCode.ALREADY_ROLLED;
      case 'NO_LEGAL_MOVES':
        return ErrorCode.NO_LEGAL_MOVES;
      default:
        return ErrorCode.INVALID_MOVE;
    }
  }
}
