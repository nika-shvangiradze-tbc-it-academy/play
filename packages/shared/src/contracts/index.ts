import { ClientIntent, ErrorCode, GameType, ServerEvent } from '../enums/index.js';

/** Client → server message envelopes (intent only — never authoritative results). */
export interface ReadyMessage {
  type: ClientIntent.READY;
}

export interface UnreadyMessage {
  type: ClientIntent.UNREADY;
}

export interface LeaveRoomMessage {
  type: ClientIntent.LEAVE_ROOM;
}

export interface RollDiceMessage {
  type: ClientIntent.ROLL_DICE;
}

export interface MoveCheckerMessage {
  type: ClientIntent.MOVE_CHECKER;
  from: number;
  to: number;
}

export interface PassMessage {
  type: ClientIntent.PASS;
}

export type ClientMessage =
  | ReadyMessage
  | UnreadyMessage
  | LeaveRoomMessage
  | RollDiceMessage
  | MoveCheckerMessage
  | PassMessage;

/** Server → client error payload. */
export interface ServerErrorPayload {
  type: ServerEvent.ERROR | ServerEvent.ACTION_REJECTED;
  code: ErrorCode;
  message: string;
}

export interface MatchStartedPayload {
  type: ServerEvent.MATCH_STARTED;
  matchId: string;
}

export interface MatchFinishedPayload {
  type: ServerEvent.MATCH_FINISHED;
  matchId: string;
  winnerUserId: string | null;
  reason: 'normal' | 'abandonment' | 'resignation';
}

export interface PlayerConnectionPayload {
  type: ServerEvent.PLAYER_DISCONNECTED | ServerEvent.PLAYER_RECONNECTED;
  userId: string;
  seatNumber: number;
  graceMsRemaining?: number;
}

/** Options passed when joining a Colyseus room. */
export interface JoinRoomOptions {
  inviteCode?: string;
  accessToken: string;
  gameType?: GameType;
}

/** Options for creating a new private room via Colyseus. */
export interface CreateRoomOptions {
  accessToken: string;
  gameType: GameType;
}

/**
 * Colyseus 0.15 seat reservation payload returned by our HTTP API.
 * Client must call `client.consumeSeatReservation(reservation)` exactly once.
 */
export interface ColyseusSeatReservation {
  sessionId: string;
  room: {
    roomId: string;
    name: string;
    processId: string;
    publicAddress?: string;
  };
}

/** HTTP API: create / join room response. */
export interface CreateRoomResponse {
  roomId: string;
  inviteCode: string;
  gameType: GameType;
  maxPlayers: number;
  colyseusRoomId: string;
  /** Required to connect — do not call joinById with only the room id. */
  reservation: ColyseusSeatReservation;
}

/** HTTP API: join-by-code lookup (minimal leak). */
export interface JoinCodeLookupResponse {
  valid: boolean;
  gameType?: GameType;
  seatsTaken?: number;
  maxPlayers?: number;
  status?: string;
}

/** Paginated match history. */
export interface PaginatedHistory {
  items: import('../models/index.js').MatchHistoryEntry[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}
