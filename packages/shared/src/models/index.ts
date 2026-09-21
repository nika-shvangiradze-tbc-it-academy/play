import { GameType, MatchResult, MatchStatus, RoomStatus } from '../enums/index.js';

export interface Profile {
  id: string;
  username: string;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
  games_played: number;
  games_won: number;
}

export interface GameRoom {
  id: string;
  invite_code: string;
  game_type: GameType;
  status: RoomStatus;
  host_user_id: string;
  max_players: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface RoomPlayer {
  id: string;
  room_id: string;
  user_id: string;
  seat_number: number;
  is_ready: boolean;
  joined_at: string;
  left_at: string | null;
}

export interface Match {
  id: string;
  room_id: string;
  game_type: GameType;
  started_at: string;
  finished_at: string | null;
  winner_user_id: string | null;
  status: MatchStatus;
  abandonment_reason: string | null;
}

export interface MatchPlayer {
  match_id: string;
  user_id: string;
  seat_number: number;
  result: MatchResult | string;
  score: number | null;
}

export interface MatchHistoryEntry {
  match_id: string;
  game_type: GameType;
  started_at: string;
  finished_at: string | null;
  status: MatchStatus;
  result: MatchResult | string;
  score: number | null;
  seat_number: number;
  winner_user_id: string | null;
  opponents: Array<{
    user_id: string;
    username: string;
    seat_number: number;
  }>;
}

export interface GameCatalogEntry {
  type: GameType;
  name: string;
  minPlayers: number;
  maxPlayers: number;
  available: boolean;
  description: string;
}

/** Seat capacity and availability metadata per game. */
export const GAME_CATALOG: readonly GameCatalogEntry[] = [
  {
    type: GameType.NARDI,
    name: 'Nardi',
    minPlayers: 2,
    maxPlayers: 2,
    available: true,
    description: 'Classic Georgian backgammon for 2 players.',
  },
  {
    type: GameType.JOKER,
    name: 'Joker',
    minPlayers: 4,
    maxPlayers: 4,
    available: false,
    description: 'Coming soon.',
  },
  {
    type: GameType.DOMINO,
    name: 'Domino',
    minPlayers: 4,
    maxPlayers: 4,
    available: false,
    description: 'Coming soon.',
  },
  {
    type: GameType.BURA,
    name: 'Bura',
    minPlayers: 2,
    maxPlayers: 4,
    available: false,
    description: 'Coming soon — 2 or 4 players.',
  },
];

export function getGameCatalogEntry(type: GameType): GameCatalogEntry | undefined {
  return GAME_CATALOG.find((g) => g.type === type);
}

export function getMaxPlayers(type: GameType): number {
  const entry = getGameCatalogEntry(type);
  if (!entry) {
    throw new Error(`Unknown game type: ${type}`);
  }
  return entry.maxPlayers;
}
