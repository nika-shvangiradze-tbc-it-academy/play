import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  ErrorCode,
  GameType,
  RoomStatus,
  normalizeInviteCode,
  isValidInviteCodeFormat,
  getGameCatalogEntry,
} from '@georgian-games/shared';
import { matchMaker } from '@colyseus/core';
import { authenticateToken, AuthError } from '../auth/verify-token.js';
import {
  createGameRoom,
  lookupRoomByInviteCode,
  reserveSeat,
  setColyseusRoomId,
} from '../db/rooms.js';
import { getEnv } from '../config/env.js';
import { RateLimiter } from '../security/rate-limiter.js';
import type { RoomMetadata } from '../rooms/BaseGameRoom.js';

const createLimiter = () =>
  new RateLimiter(getEnv().RATE_LIMIT_CREATE_ROOM_PER_MIN, 60_000);
const joinLimiter = () =>
  new RateLimiter(getEnv().RATE_LIMIT_JOIN_ROOM_PER_MIN, 60_000);

let createRoomLimiter = createLimiter();
let joinRoomLimiter = joinLimiter();

async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ code: ErrorCode.UNAUTHENTICATED, message: 'Missing bearer token' });
      return;
    }
    const token = header.slice('Bearer '.length);
    const profile = await authenticateToken(token);
    (req as Request & { profile: typeof profile }).profile = profile;
    (req as Request & { accessToken: string }).accessToken = token;
    next();
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(401).json({ code: err.code, message: err.message });
      return;
    }
    console.error('[http auth]', err);
    res.status(500).json({ code: ErrorCode.SERVER_ERROR, message: 'Auth failed' });
  }
}

function clientKey(req: Request): string {
  const profile = (req as Request & { profile?: { userId: string } }).profile;
  return profile?.userId ?? req.ip ?? 'unknown';
}

export function createApiRouter(): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  router.post('/rooms', requireAuth, async (req, res) => {
    try {
      if (!createRoomLimiter.tryRemoveToken(clientKey(req))) {
        res.status(429).json({ code: ErrorCode.RATE_LIMITED, message: 'Too many rooms created' });
        return;
      }

      const gameType = req.body?.gameType as GameType | undefined;
      const entry = gameType ? getGameCatalogEntry(gameType) : undefined;
      if (!entry || !entry.available) {
        res.status(400).json({ code: ErrorCode.FORBIDDEN, message: 'Game not available' });
        return;
      }

      const profile = (req as Request & { profile: { userId: string; username: string } }).profile;
      const created = await createGameRoom(profile.userId, gameType!);

      const metadata: RoomMetadata = {
        dbRoomId: created.roomId,
        inviteCode: created.inviteCode,
        gameType: created.gameType,
        hostUserId: profile.userId,
        maxPlayers: created.maxPlayers,
      };

      const room = await matchMaker.createRoom('nardi', metadata);
      await setColyseusRoomId(created.roomId, room.roomId);

      res.status(201).json({
        roomId: created.roomId,
        inviteCode: created.inviteCode,
        gameType: created.gameType,
        maxPlayers: created.maxPlayers,
        colyseusRoomId: room.roomId,
      });
    } catch (err) {
      console.error('[POST /rooms]', err);
      res.status(500).json({ code: ErrorCode.SERVER_ERROR, message: 'Failed to create room' });
    }
  });

  /** Minimal invite lookup — does not leak player identities. */
  router.get('/rooms/by-code/:code', requireAuth, async (req, res) => {
    try {
      if (!joinRoomLimiter.tryRemoveToken(`lookup:${clientKey(req)}`)) {
        res.status(429).json({ code: ErrorCode.RATE_LIMITED, message: 'Too many join attempts' });
        return;
      }

      const code = normalizeInviteCode(String(req.params['code'] ?? ''));
      if (!isValidInviteCodeFormat(code)) {
        res.status(404).json({ valid: false, code: ErrorCode.INVALID_INVITE_CODE });
        return;
      }

      const room = await lookupRoomByInviteCode(code);
      if (!room) {
        res.status(404).json({ valid: false, code: ErrorCode.INVALID_INVITE_CODE });
        return;
      }

      if (
        room.status === RoomStatus.FINISHED ||
        room.status === RoomStatus.ABANDONED ||
        room.status === RoomStatus.CANCELLED
      ) {
        res.status(410).json({ valid: false, code: ErrorCode.ROOM_CLOSED });
        return;
      }

      res.json({
        valid: true,
        gameType: room.gameType,
        seatsTaken: room.seatsTaken,
        maxPlayers: room.maxPlayers,
        status: room.status,
        colyseusRoomId: room.colyseusRoomId,
        inviteCode: room.inviteCode,
      });
    } catch (err) {
      console.error('[GET /rooms/by-code]', err);
      res.status(500).json({ code: ErrorCode.SERVER_ERROR, message: 'Lookup failed' });
    }
  });

  /** Reserve seat then return Colyseus room id for join. */
  router.post('/rooms/join', requireAuth, async (req, res) => {
    try {
      if (!joinRoomLimiter.tryRemoveToken(`join:${clientKey(req)}`)) {
        res.status(429).json({ code: ErrorCode.RATE_LIMITED, message: 'Too many join attempts' });
        return;
      }

      const code = normalizeInviteCode(String(req.body?.inviteCode ?? ''));
      if (!isValidInviteCodeFormat(code)) {
        res.status(400).json({ code: ErrorCode.INVALID_INVITE_CODE, message: 'Invalid invite code' });
        return;
      }

      const room = await lookupRoomByInviteCode(code);
      if (!room) {
        res.status(404).json({ code: ErrorCode.INVALID_INVITE_CODE, message: 'Room not found' });
        return;
      }

      if (
        room.status === RoomStatus.PLAYING ||
        room.status === RoomStatus.STARTING
      ) {
        // Allow only if already a participant (reconnect path uses Colyseus directly)
        res.status(409).json({
          code: ErrorCode.GAME_ALREADY_STARTED,
          message: 'Game already started',
          colyseusRoomId: room.colyseusRoomId,
        });
        return;
      }

      if (
        room.status === RoomStatus.FINISHED ||
        room.status === RoomStatus.ABANDONED ||
        room.status === RoomStatus.CANCELLED
      ) {
        res.status(410).json({ code: ErrorCode.ROOM_CLOSED, message: 'Room closed' });
        return;
      }

      if (room.seatsTaken >= room.maxPlayers) {
        res.status(409).json({ code: ErrorCode.ROOM_FULL, message: 'Room is full' });
        return;
      }

      if (!room.colyseusRoomId) {
        res.status(503).json({ code: ErrorCode.SERVER_ERROR, message: 'Room not ready' });
        return;
      }

      const profile = (req as Request & { profile: { userId: string } }).profile;
      const seatNumber = room.seatsTaken; // host is 0; next free approximate — Colyseus assigns exactly

      try {
        await reserveSeat(room.id, profile.userId, seatNumber);
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg === 'SEAT_TAKEN') {
          res.status(409).json({ code: ErrorCode.SEAT_TAKEN, message: 'Seat taken' });
          return;
        }
        throw err;
      }

      res.json({
        roomId: room.id,
        inviteCode: room.inviteCode,
        gameType: room.gameType,
        colyseusRoomId: room.colyseusRoomId,
        maxPlayers: room.maxPlayers,
      });
    } catch (err) {
      console.error('[POST /rooms/join]', err);
      res.status(500).json({ code: ErrorCode.SERVER_ERROR, message: 'Join failed' });
    }
  });

  return router;
}
