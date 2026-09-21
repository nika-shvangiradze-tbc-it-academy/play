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

export interface RoomLookup {
  id: string;
  inviteCode: string;
  gameType: GameType;
  status: RoomStatus;
  maxPlayers: number;
  hostUserId: string;
  colyseusRoomId: string | null;
  seatsTaken: number;
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

  const { count } = await supabase
    .from('room_players')
    .select('id', { count: 'exact', head: true })
    .eq('room_id', room.id)
    .is('left_at', null);

  return {
    id: room.id as string,
    inviteCode: room.invite_code as string,
    gameType: room.game_type as GameType,
    status: room.status as RoomStatus,
    maxPlayers: room.max_players as number,
    hostUserId: room.host_user_id as string,
    colyseusRoomId: (room.colyseus_room_id as string | null) ?? null,
    seatsTaken: count ?? 0,
  };
}

export async function reserveSeat(
  roomId: string,
  userId: string,
  seatNumber: number,
): Promise<void> {
  const supabase = getAdminClient();

  // Rejoin: clear left_at if previously left same room
  const { data: existing } = await supabase
    .from('room_players')
    .select('id, left_at, seat_number')
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .maybeSingle();

  if (existing && existing.left_at === null) {
    return; // already seated
  }

  if (existing) {
    const { error } = await supabase
      .from('room_players')
      .update({
        left_at: null,
        is_ready: false,
        seat_number: seatNumber,
        joined_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
    if (error) throw new Error(`Failed to reseat player: ${error.message}`);
    return;
  }

  const { error } = await supabase.from('room_players').insert({
    room_id: roomId,
    user_id: userId,
    seat_number: seatNumber,
    is_ready: false,
  });

  if (error) {
    if (error.code === '23505') {
      throw new Error('SEAT_TAKEN');
    }
    throw new Error(`Failed to reserve seat: ${error.message}`);
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
    // Unique active match — fetch existing (idempotent start)
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
