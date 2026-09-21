import { Schema, type, ArraySchema, MapSchema } from '@colyseus/schema';
import { NardiPhase, RoomPhase } from '@georgian-games/shared';

export class SeatSchema extends Schema {
  @type('string') userId: string = '';
  @type('string') username: string = '';
  @type('number') seatNumber: number = 0;
  @type('boolean') isReady: boolean = false;
  @type('boolean') connected: boolean = true;
  @type('boolean') reconnecting: boolean = false;
}

export class DiceSchema extends Schema {
  @type('number') d1: number = 0;
  @type('number') d2: number = 0;
  @type('boolean') rolled: boolean = false;
  @type(['number']) remaining = new ArraySchema<number>();
}

export class LegalMoveSchema extends Schema {
  @type('number') from: number = 0;
  @type('number') to: number = 0;
  @type('number') die: number = 0;
  @type('boolean') hit: boolean = false;
}

/**
 * Authoritative synchronized room state.
 * Clients render this; they never invent game outcomes.
 */
export class GameRoomState extends Schema {
  @type('string') dbRoomId: string = '';
  @type('string') inviteCode: string = '';
  @type('string') gameType: string = '';
  @type('string') phase: string = RoomPhase.WAITING;
  @type('string') hostUserId: string = '';
  @type('number') maxPlayers: number = 2;
  @type('string') matchId: string = '';
  @type('string') nardiPhase: string = NardiPhase.WAITING_FOR_ROLL;
  @type('number') currentTurn: number = 0;
  @type('number') turnNumber: number = 1;
  @type('number') winnerSeat: number = -1;
  @type(DiceSchema) dice = new DiceSchema();
  /** Board points 1–24 packed as numbers (same convention as engine). */
  @type(['number']) points = new ArraySchema<number>();
  @type('number') bar0: number = 0;
  @type('number') bar1: number = 0;
  @type('number') off0: number = 0;
  @type('number') off1: number = 0;
  @type({ map: SeatSchema }) seats = new MapSchema<SeatSchema>();
  @type([LegalMoveSchema]) legalMoves = new ArraySchema<LegalMoveSchema>();
}
