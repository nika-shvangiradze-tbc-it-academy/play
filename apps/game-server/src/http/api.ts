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
  abandonOrphanRoom,
  createGameRoom,
  evaluateJoinOccupancy,
  getRoomOccupancy,
  lookupRoomByInviteCode,
  setColyseusRoomId,
  shortUserId,
} from '../db/rooms.js';
import { getEnv } from '../config/env.js';
import { RateLimiter } from '../security/rate-limiter.js';
import type { RoomMetadata } from '../rooms/BaseGameRoom.js';
import { TimeoutError, withTimeout } from './with-timeout.js';

/** Bound external awaits so POST /api/rooms can never stay pending forever. */
function timeoutMs(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const AUTH_TIMEOUT_MS = () => timeoutMs('ROOMS_CREATE_AUTH_TIMEOUT_MS', 10_000);
const DB_TIMEOUT_MS = () => timeoutMs('ROOMS_CREATE_DB_TIMEOUT_MS', 15_000);
const COLYSEUS_TIMEOUT_MS = () => timeoutMs('ROOMS_CREATE_COLYSEUS_TIMEOUT_MS', 10_000);

const createLimiter = () =>
  new RateLimiter(getEnv().RATE_LIMIT_CREATE_ROOM_PER_MIN, 60_000);
const joinLimiter = () =>
  new RateLimiter(getEnv().RATE_LIMIT_JOIN_ROOM_PER_MIN, 60_000);

let createRoomLimiter = createLimiter();
let joinRoomLimiter = joinLimiter();

type AuthedRequest = Request & {
  profile: { userId: string; username: string };
  accessToken: string;
};

function safeErrorMessage(err: unknown): string {
  if (err instanceof TimeoutError) return err.message;
  if (err instanceof Error) return err.message;
  return 'unknown error';
}

function safeErrorName(err: unknown): string {
  if (err instanceof Error && err.name) return err.name;
  return typeof err;
}

function respondOnce(
  res: Response,
  status: number,
  body: Record<string, unknown>,
): void {
  if (res.headersSent) {
    console.error('[rooms:create] response already sent; skipping', status);
    return;
  }
  res.status(status).json(body);
}

async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ code: ErrorCode.UNAUTHENTICATED, message: 'Missing bearer token' });
      return;
    }
    const token = header.slice('Bearer '.length);
    const profile = await withTimeout(
      authenticateToken(token),
      AUTH_TIMEOUT_MS(),
      'authenticateToken',
    );
    (req as AuthedRequest).profile = profile;
    (req as AuthedRequest).accessToken = token;
    next();
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(401).json({ code: err.code, message: err.message });
      return;
    }
    if (err instanceof TimeoutError) {
      console.error('[http auth] timeout', safeErrorMessage(err));
      res.status(504).json({ code: ErrorCode.SERVER_ERROR, message: 'Auth timed out' });
      return;
    }
    console.error('[http auth]', safeErrorName(err), safeErrorMessage(err));
    res.status(500).json({ code: ErrorCode.SERVER_ERROR, message: 'Auth failed' });
  }
}

function clientKey(req: Request): string {
  const profile = (req as Request & { profile?: { userId: string } }).profile;
  return profile?.userId ?? req.ip ?? 'unknown';
}

function matchMakerReady(): boolean {
  return matchMaker.state === matchMaker.MatchMakerState.READY;
}

/**
 * Create Colyseus room on this process only (single-node Render).
 * Avoids IPC to a stale processId from presence stats, which can stall createRoom.
 */
async function createLocalColyseusRoom(metadata: RoomMetadata) {
  try {
    matchMaker.getHandler('nardi');
  } catch {
    throw new Error('Colyseus room type "nardi" is not registered');
  }
  if (!matchMakerReady()) {
    throw new Error(
      `Colyseus matchMaker not READY (state=${String(matchMaker.state)}); was gameServer.listen() awaited?`,
    );
  }
  // Prefer local handleCreateRoom when available — skips selectProcessId / IPC.
  if (typeof matchMaker.handleCreateRoom === 'function') {
    return matchMaker.handleCreateRoom('nardi', metadata);
  }
  return matchMaker.createRoom('nardi', metadata);
}

export function createApiRouter(): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    let nardiRegistered = false;
    try {
      matchMaker.getHandler('nardi');
      nardiRegistered = true;
    } catch {
      nardiRegistered = false;
    }
    res.json({
      ok: true,
      matchMakerReady: matchMakerReady(),
      nardiRegistered,
    });
  });

  router.post('/rooms', requireAuth, async (req, res) => {
    let dbRoomId: string | undefined;
    const startedAt = Date.now();
    try {
      console.log('[rooms:create] request received');

      if (!createRoomLimiter.tryRemoveToken(clientKey(req))) {
        respondOnce(res, 429, {
          code: ErrorCode.RATE_LIMITED,
          message: 'Too many rooms created',
        });
        return;
      }

      console.log('[rooms:create] auth complete');
      const profile = (req as AuthedRequest).profile;
      console.log('[rooms:create] profile loaded');

      const gameType = req.body?.gameType as GameType | undefined;
      const entry = gameType ? getGameCatalogEntry(gameType) : undefined;
      if (!entry || !entry.available) {
        respondOnce(res, 400, {
          code: ErrorCode.FORBIDDEN,
          message: 'Game not available',
        });
        return;
      }

      let nardiRegistered = false;
      try {
        matchMaker.getHandler('nardi');
        nardiRegistered = true;
      } catch {
        nardiRegistered = false;
      }
      console.log(
        `[rooms:create] matchMaker state=${String(matchMaker.state)} processId=${matchMaker.processId ?? 'none'} nardi=${nardiRegistered}`,
      );

      console.log('[rooms:create] creating database room');
      const created = await withTimeout(
        createGameRoom(profile.userId, gameType!),
        DB_TIMEOUT_MS(),
        'createGameRoom',
      );
      dbRoomId = created.roomId;
      const occupancy = await withTimeout(
        getRoomOccupancy(created.roomId),
        DB_TIMEOUT_MS(),
        'getRoomOccupancy',
      );
      console.log(
        `[rooms:create] database room created members=${occupancy.totalRows} distinct=${occupancy.distinctCount}`,
      );

      const metadata: RoomMetadata = {
        dbRoomId: created.roomId,
        inviteCode: created.inviteCode,
        gameType: created.gameType,
        hostUserId: profile.userId,
        maxPlayers: created.maxPlayers,
      };

      console.log('[rooms:create] creating Colyseus room');
      const room = await withTimeout(
        createLocalColyseusRoom(metadata),
        COLYSEUS_TIMEOUT_MS(),
        'matchMaker.createRoom',
      );
      const live = matchMaker.getRoomById(room.roomId) as
        | { clients?: { length: number } }
        | undefined;
      const clientCount = live?.clients?.length ?? 0;
      console.log(
        `[rooms:create] Colyseus room created clients=${clientCount}/${created.maxPlayers}`,
      );

      await withTimeout(
        setColyseusRoomId(created.roomId, room.roomId),
        DB_TIMEOUT_MS(),
        'setColyseusRoomId',
      );

      console.log(
        `[rooms:create] sending response elapsedMs=${Date.now() - startedAt} dbRoomId=${created.roomId} colyseusRoomId=${room.roomId}`,
      );
      respondOnce(res, 201, {
        roomId: created.roomId,
        inviteCode: created.inviteCode,
        gameType: created.gameType,
        maxPlayers: created.maxPlayers,
        colyseusRoomId: room.roomId,
      });
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      console.error(
        `[rooms:create] failed elapsedMs=${elapsedMs} dbRoomId=${dbRoomId ?? 'none'} name=${safeErrorName(err)} message=${safeErrorMessage(err)}`,
      );
      if (err instanceof Error && err.stack) {
        console.error('[rooms:create] stack', err.stack);
      }

      if (dbRoomId) {
        try {
          await withTimeout(abandonOrphanRoom(dbRoomId), DB_TIMEOUT_MS(), 'abandonOrphanRoom');
          console.log('[rooms:create] orphan database room deleted', dbRoomId);
        } catch (cleanupErr) {
          console.error(
            '[rooms:create] orphan cleanup failed',
            safeErrorName(cleanupErr),
            safeErrorMessage(cleanupErr),
          );
        }
      }

      if (err instanceof TimeoutError) {
        respondOnce(res, 504, {
          code: ErrorCode.SERVER_ERROR,
          message: 'Create room timed out',
        });
        return;
      }

      respondOnce(res, 500, {
        code: ErrorCode.SERVER_ERROR,
        message: 'Failed to create room',
      });
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

  /** Validate invite + occupancy, then return Colyseus room id for joinById.
   * Membership is NOT inserted here — Colyseus onJoin is authoritative for guests
   * so a failed WebSocket join cannot permanently consume a seat.
   */
  router.post('/rooms/join', requireAuth, async (req, res) => {
    try {
      if (!joinRoomLimiter.tryRemoveToken(`join:${clientKey(req)}`)) {
        res.status(429).json({ code: ErrorCode.RATE_LIMITED, message: 'Too many join attempts' });
        return;
      }

      const code = normalizeInviteCode(String(req.body?.inviteCode ?? ''));
      console.log(`[rooms:join] invite=${code || '(empty)'}`);
      if (!isValidInviteCodeFormat(code)) {
        res.status(400).json({ code: ErrorCode.INVALID_INVITE_CODE, message: 'Invalid invite code' });
        return;
      }

      const room = await lookupRoomByInviteCode(code);
      if (!room) {
        res.status(404).json({ code: ErrorCode.INVALID_INVITE_CODE, message: 'Room not found' });
        return;
      }

      const profile = (req as AuthedRequest).profile;
      const occupancyCheck = evaluateJoinOccupancy(
        room.memberIds,
        room.maxPlayers,
        profile.userId,
      );

      console.log(
        `[rooms:join] db members=${room.seatsTaken} distinct=${occupancyCheck.distinctCount}`,
      );
      console.log(
        `[rooms:join] requesting user alreadyMember=${occupancyCheck.alreadyMember} user=${shortUserId(profile.userId)}`,
      );

      if (
        room.status === RoomStatus.PLAYING ||
        room.status === RoomStatus.STARTING
      ) {
        if (occupancyCheck.alreadyMember && room.colyseusRoomId) {
          // Reconnect path for a seated player after match start.
          res.json({
            roomId: room.id,
            inviteCode: room.inviteCode,
            gameType: room.gameType,
            colyseusRoomId: room.colyseusRoomId,
            maxPlayers: room.maxPlayers,
          });
          return;
        }
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

      if (occupancyCheck.isFull) {
        res.status(409).json({ code: ErrorCode.ROOM_FULL, message: 'Room is full' });
        return;
      }

      if (!room.colyseusRoomId) {
        res.status(503).json({ code: ErrorCode.SERVER_ERROR, message: 'Room not ready' });
        return;
      }

      const live = matchMaker.getRoomById(room.colyseusRoomId) as
        | { clients?: { length: number }; hasReachedMaxClients?: () => boolean }
        | undefined;
      const clientCount = live?.clients?.length ?? 0;
      console.log(
        `[rooms:join] colyseus room=${room.colyseusRoomId} clients=${clientCount}/${room.maxPlayers}`,
      );

      // Soft check against live Colyseus capacity (does not insert DB rows).
      if (!occupancyCheck.alreadyMember && live?.hasReachedMaxClients?.()) {
        res.status(409).json({ code: ErrorCode.ROOM_FULL, message: 'Room is full' });
        return;
      }

      console.log('[rooms:join] reservation created');
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

/** Test-only: reset in-memory rate limiters between cases. */
export function resetApiRateLimitersForTests(): void {
  createRoomLimiter = createLimiter();
  joinRoomLimiter = joinLimiter();
}
