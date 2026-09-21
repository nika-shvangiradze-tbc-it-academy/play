import {
  generateUniqueInviteCode,
  getMaxPlayers,
  GameType,
  RoomStatus,
  MatchStatus,
  type Profile,
} from '@georgian-games/shared';
import { getAdminClient } from '../db/supabase.js';

export interface CreatedRoom {
  roomId: string;
  inviteCode: string;
  gameType: GameType;
  maxPlayers: number;
}

export interface RoomOccupancy {
  /** Active member user ids (left_at IS NULL), de-duplicated. */
  memberIds: string[];
  /** Raw active row count (should match distinct unless integrity is broken). */
  totalRows: number;
  distinctCount: number;
}

export function shortUserId(userId: string): string {
  return userId.length <= 8 ? userId : userId.slice(0, 8);
}

/**
 * Occupancy for join checks: distinct active user ids only.
 * Never treat duplicate rows for the same user as two seats.
 */
export function evaluateJoinOccupancy(
  memberIds: string[],
  maxPlayers: number,
  requestingUserId: string,
): { alreadyMember: boolean; distinctCount: number; isFull: boolean } {
  const unique = [...new Set(memberIds)];
  const alreadyMember = unique.includes(requestingUserId);
  const distinctCount = unique.length;
  const isFull = !alreadyMember && distinctCount >= maxPlayers;
  return { alreadyMember, distinctCount, isFull };
}

export async function createGameRoom(
  hostUserId: string,
  gameType: GameType,
): Promise<CreatedRoom> {
  const supabase = getAdminClient();
  const maxPlayers = getMaxPlayers(gameType);

  const inviteCode = await generateUniqueInviteCode(async (code) => {
    const { data } = await supabase
      .from('game_rooms')
      .select('id')
      .eq('invite_code', code)
      .maybeSingle();
    return !!data;
  });

  const { data: room, error } = await supabase
    .from('game_rooms')
    .insert({
      invite_code: inviteCode,
      game_type: gameType,
      status: RoomStatus.WAITING,
      host_user_id: hostUserId,
      max_players: maxPlayers,
    })
    .select('id, invite_code, game_type, max_players')
    .single();

  if (error || !room) {
    throw new Error(`Failed to create room: ${error?.message ?? 'unknown'}`);
  }

  // Host claims seat 0 in DB. Colyseus onJoin must not create a second row (idempotent upsert).
  const { error: seatError } = await supabase.from('room_players').insert({
    room_id: room.id,
    user_id: hostUserId,
    seat_number: 0,
    is_ready: false,
  });

  if (seatError) {
    await supabase.from('game_rooms').delete().eq('id', room.id);
    throw new Error(`Failed to seat host: ${seatError.message}`);
  }

  return {
    roomId: room.id as string,
    inviteCode: room.invite_code as string,
    gameType: room.game_type as GameType,
    maxPlayers: room.max_players as number,
  };
}

export async function setColyseusRoomId(roomId: string, colyseusRoomId: string): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase
    .from('game_rooms')
    .update({ colyseus_room_id: colyseusRoomId })
    .eq('id', roomId);
  if (error) {
    throw new Error(`Failed to link Colyseus room: ${error.message}`);
  }
}

/**
 * Best-effort cleanup when Colyseus room creation fails after the DB row exists.
 * Deletes the incomplete room (and cascaded seats) so invite codes are not left half-created.
 */
export async function abandonOrphanRoom(roomId: string): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase.from('game_rooms').delete().eq('id', roomId);
  if (error) {
    console.error('[rooms] abandonOrphanRoom delete failed', roomId, error.message);
    throw new Error(`Failed to abandon orphan room: ${error.message}`);
  }
}

export async function getRoomOccupancy(roomId: string): Promise<RoomOccupancy> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from('room_players')
    .select('user_id')
    .eq('room_id', roomId)
    .is('left_at', null);

  if (error) {
    throw new Error(`Occupancy lookup failed: ${error.message}`);
  }

  const rows = data ?? [];
  const memberIds = [...new Set(rows.map((r) => r.user_id as string))];
  return {
    memberIds,
    totalRows: rows.length,
    distinctCount: memberIds.length,
  };
}

export interface RoomLookup {
  id: string;
  inviteCode: string;
  gameType: GameType;
  status: RoomStatus;
  maxPlayers: number;
  hostUserId: string;
  colyseusRoomId: string | null;
  /** Distinct active members — authoritative for fullness. */
  seatsTaken: number;
  memberIds: string[];
}

export async function lookupRoomByInviteCode(inviteCode: string): Promise<RoomLookup | null> {
  const supabase = getAdminClient();
  const { data: room, error } = await supabase
    .from('game_rooms')
    .select('id, invite_code, game_type, status, max_players, host_user_id, colyseus_room_id')
    .eq('invite_code', inviteCode)
    .maybeSingle();

  if (error) {
    throw new Error(`Room lookup failed: ${error.message}`);
  }
  if (!room) return null;

  const occupancy = await getRoomOccupancy(room.id as string);

  return {
    id: room.id as string,
    inviteCode: room.invite_code as string,
    gameType: room.game_type as GameType,
    status: room.status as RoomStatus,
    maxPlayers: room.max_players as number,
    hostUserId: room.host_user_id as string,
    colyseusRoomId: (room.colyseus_room_id as string | null) ?? null,
    seatsTaken: occupancy.distinctCount,
    memberIds: occupancy.memberIds,
  };
}

/**
 * Idempotent membership upsert — Colyseus onJoin is the authority for guests.
 * Safe to call on every join/reconnect; never creates duplicate active rows.
 */
export async function ensureRoomMembership(
  roomId: string,
  userId: string,
  seatNumber: number,
): Promise<'created' | 'reseat' | 'existing'> {
  const supabase = getAdminClient();

  const { data: active, error: activeError } = await supabase
    .from('room_players')
    .select('id, seat_number')
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .is('left_at', null)
    .maybeSingle();

  if (activeError) {
    throw new Error(`Failed to load membership: ${activeError.message}`);
  }
  if (active) {
    return 'existing';
  }

  const { data: prior, error: priorError } = await supabase
    .from('room_players')
    .select('id')
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .not('left_at', 'is', null)
    .order('joined_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (priorError) {
    throw new Error(`Failed to load prior membership: ${priorError.message}`);
  }

  if (prior) {
    const { error } = await supabase
      .from('room_players')
      .update({
        left_at: null,
        is_ready: false,
        seat_number: seatNumber,
        joined_at: new Date().toISOString(),
      })
      .eq('id', prior.id);
    if (error) throw new Error(`Failed to reseat player: ${error.message}`);
    return 'reseat';
  }

  const { error } = await supabase.from('room_players').insert({
    room_id: roomId,
    user_id: userId,
    seat_number: seatNumber,
    is_ready: false,
  });

  if (error) {
    if (error.code === '23505') {
      return 'existing';
    }
    throw new Error(`Failed to ensure membership: ${error.message}`);
  }
  return 'created';
}

/**
 * @deprecated Prefer ensureRoomMembership from Colyseus onJoin.
 * Kept for tests that simulate the old HTTP pre-reserve path.
 */
export async function reserveSeat(
  roomId: string,
  userId: string,
  seatNumber: number,
): Promise<void> {
  const result = await ensureRoomMembership(roomId, userId, seatNumber);
  if (result === 'existing' || result === 'reseat' || result === 'created') {
    return;
  }
}

export async function markPlayerLeft(roomId: string, userId: string): Promise<void> {
  const supabase = getAdminClient();
  await supabase
    .from('room_players')
    .update({ left_at: new Date().toISOString(), is_ready: false })
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .is('left_at', null);
}

export async function setPlayerReady(
  roomId: string,
  userId: string,
  isReady: boolean,
): Promise<void> {
  const supabase = getAdminClient();
  await supabase
    .from('room_players')
    .update({ is_ready: isReady })
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .is('left_at', null);
}

export async function updateRoomStatus(
  roomId: string,
  status: RoomStatus,
  extra: { started_at?: string; finished_at?: string } = {},
): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase
    .from('game_rooms')
    .update({ status, ...extra })
    .eq('id', roomId);
  if (error) throw new Error(`Failed to update room status: ${error.message}`);
}

export async function createMatchRecord(
  roomId: string,
  gameType: GameType,
  players: Array<{ userId: string; seatNumber: number }>,
): Promise<string> {
  const supabase = getAdminClient();

  const { data: match, error } = await supabase
    .from('matches')
    .insert({
      room_id: roomId,
      game_type: gameType,
      status: MatchStatus.IN_PROGRESS,
    })
    .select('id')
    .single();

  if (error || !match) {
    if (error?.code === '23505') {
      const { data: existing } = await supabase
        .from('matches')
        .select('id')
        .eq('room_id', roomId)
        .eq('status', MatchStatus.IN_PROGRESS)
        .maybeSingle();
      if (existing) return existing.id as string;
    }
    throw new Error(`Failed to create match: ${error?.message ?? 'unknown'}`);
  }

  const rows = players.map((p) => ({
    match_id: match.id,
    user_id: p.userId,
    seat_number: p.seatNumber,
  }));

  const { error: mpError } = await supabase.from('match_players').insert(rows);
  if (mpError) {
    throw new Error(`Failed to insert match players: ${mpError.message}`);
  }

  return match.id as string;
}

export async function completeMatchIdempotent(
  matchId: string,
  winnerUserId: string | null,
  status: MatchStatus = MatchStatus.COMPLETED,
  abandonmentReason: string | null = null,
): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase.rpc('complete_match', {
    p_match_id: matchId,
    p_winner_user_id: winnerUserId,
    p_status: status,
    p_abandonment_reason: abandonmentReason,
  });
  if (error) {
    throw new Error(`Failed to complete match: ${error.message}`);
  }
}

export async function getProfile(userId: string): Promise<Pick<Profile, 'id' | 'username' | 'avatar_url'> | null> {
  const supabase = getAdminClient();
  const { data } = await supabase
    .from('profiles')
    .select('id, username, avatar_url')
    .eq('id', userId)
    .maybeSingle();
  return data as Pick<Profile, 'id' | 'username' | 'avatar_url'> | null;
}
