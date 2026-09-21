/** Supported game types on the platform. */
export enum GameType {
  NARDI = 'nardi',
  JOKER = 'joker',
  DOMINO = 'domino',
  BURA = 'bura',
}

/** Durable room status stored in PostgreSQL. */
export enum RoomStatus {
  WAITING = 'waiting',
  STARTING = 'starting',
  PLAYING = 'playing',
  FINISHED = 'finished',
  ABANDONED = 'abandoned',
  CANCELLED = 'cancelled',
}

/** Durable match status. */
export enum MatchStatus {
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  ABANDONED = 'abandoned',
}

/** High-level lobby / match lifecycle phases (server-authoritative). */
export enum RoomPhase {
  WAITING = 'WAITING',
  READY = 'READY',
  STARTING = 'STARTING',
  PLAYING = 'PLAYING',
  FINISHED = 'FINISHED',
}

/** Nardi turn / play sub-phases. */
export enum NardiPhase {
  WAITING_FOR_ROLL = 'WAITING_FOR_ROLL',
  WAITING_FOR_MOVE = 'WAITING_FOR_MOVE',
  TURN_COMPLETE = 'TURN_COMPLETE',
  GAME_OVER = 'GAME_OVER',
}

/** Match player result labels. */
export enum MatchResult {
  WIN = 'win',
  LOSS = 'loss',
  DRAW = 'draw',
  ABANDONED = 'abandoned',
}

/** Machine-readable client → server intents. */
export enum ClientIntent {
  READY = 'READY',
  UNREADY = 'UNREADY',
  LEAVE_ROOM = 'LEAVE_ROOM',
  ROLL_DICE = 'ROLL_DICE',
  MOVE_CHECKER = 'MOVE_CHECKER',
  PASS = 'PASS',
}

/** Machine-readable server → client events. */
export enum ServerEvent {
  ERROR = 'ERROR',
  ROOM_STATE = 'ROOM_STATE',
  MATCH_STARTED = 'MATCH_STARTED',
  MATCH_FINISHED = 'MATCH_FINISHED',
  PLAYER_DISCONNECTED = 'PLAYER_DISCONNECTED',
  PLAYER_RECONNECTED = 'PLAYER_RECONNECTED',
  ACTION_REJECTED = 'ACTION_REJECTED',
}

/** Error codes returned to clients (never stack traces). */
export enum ErrorCode {
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  INVALID_TOKEN = 'INVALID_TOKEN',
  EXPIRED_TOKEN = 'EXPIRED_TOKEN',
  INVALID_INVITE_CODE = 'INVALID_INVITE_CODE',
  ROOM_FULL = 'ROOM_FULL',
  ROOM_CLOSED = 'ROOM_CLOSED',
  GAME_ALREADY_STARTED = 'GAME_ALREADY_STARTED',
  DUPLICATE_CONNECTION = 'DUPLICATE_CONNECTION',
  NOT_YOUR_TURN = 'NOT_YOUR_TURN',
  INVALID_PHASE = 'INVALID_PHASE',
  INVALID_MOVE = 'INVALID_MOVE',
  ALREADY_ROLLED = 'ALREADY_ROLLED',
  NO_LEGAL_MOVES = 'NO_LEGAL_MOVES',
  PLAYER_RECONNECTING = 'PLAYER_RECONNECTING',
  RATE_LIMITED = 'RATE_LIMITED',
  SERVER_ERROR = 'SERVER_ERROR',
  FORBIDDEN = 'FORBIDDEN',
  SEAT_TAKEN = 'SEAT_TAKEN',
  NOT_IN_ROOM = 'NOT_IN_ROOM',
}
