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
  clearColyseusRoomIdIfMatch,
  createGameRoom,
  evaluateJoinOccupancy,
  lookupRoomById,
  lookupRoomByInviteCode,
  setColyseusRoomId,
} from '../db/rooms.js';
import { getEnv } from '../config/env.js';
import { RateLimiter } from '../security/rate-limiter.js';
import type { RoomMetadata } from '../rooms/BaseGameRoom.js';
import { TimeoutError, withTimeout } from './with-timeout.js';
import { isRoomNotFoundError, toClientReservation } from './seat-reservation.js';
import { newLifecycleTraceId, shortId, traceLog } from './lifecycle-trace.js';

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
 * Create private Nardi room + reserve creator seat (Colyseus 0.15).
 * Empty createRoom alone auto-disposes; reserveSeatFor keeps the room alive
 * until the client consumes the reservation (or the seat TTL expires).
 */
async function createPrivateRoomWithCreatorSeat(
  metadata: RoomMetadata,
  accessToken: string,
) {
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

  const listing =
    typeof matchMaker.handleCreateRoom === 'function'
      ? await matchMaker.handleCreateRoom('nardi', metadata)
      : await matchMaker.createRoom('nardi', metadata);

  const reservation = await matchMaker.reserveSeatFor(listing, {
    accessToken,
  });
  return reservation;
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
    const lifecycleTraceId = newLifecycleTraceId();
    try {
      traceLog(lifecycleTraceId, 'HTTP CREATE begin');

      if (!createRoomLimiter.tryRemoveToken(clientKey(req))) {
        respondOnce(res, 429, {
          code: ErrorCode.RATE_LIMITED,
          message: 'Too many rooms created',
        });
        return;
      }

      const profile = (req as AuthedRequest).profile;

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
      traceLog(
        lifecycleTraceId,
        `matchMaker state=${String(matchMaker.state)} nardi=${nardiRegistered}`,
      );

      const created = await withTimeout(
        createGameRoom(profile.userId, gameType!),
        DB_TIMEOUT_MS(),
        'createGameRoom',
      );
      dbRoomId = created.roomId;
      traceLog(
        lifecycleTraceId,
        `DB room created id=${shortId(created.roomId, 8)} invite=${created.inviteCode}`,
      );

      const metadata: RoomMetadata = {
        dbRoomId: created.roomId,
        inviteCode: created.inviteCode,
        gameType: created.gameType,
        hostUserId: profile.userId,
        maxPlayers: created.maxPlayers,
        lifecycleTraceId,
      };

      const accessToken = (req as AuthedRequest).accessToken;
      const reservation = await withTimeout(
        createPrivateRoomWithCreatorSeat(metadata, accessToken),
        COLYSEUS_TIMEOUT_MS(),
        'matchMaker.create+reserveSeatFor',
      );
      const colyseusRoomId = reservation.room.roomId;
      const live = matchMaker.getRoomById(colyseusRoomId) as unknown as
        | { clients?: { length: number }; reservedSeats?: Record<string, unknown> }
        | undefined;
      const clientCount = live?.clients?.length ?? 0;
      const reservedCount = live?.reservedSeats
        ? Object.keys(live.reservedSeats).length
        : 0;
      traceLog(
        lifecycleTraceId,
        `Colyseus room created id=${colyseusRoomId} publicAddress=${reservation.room.publicAddress ?? 'none'}`,
      );
      traceLog(
        lifecycleTraceId,
        `creator seat reserved session=${shortId(String(reservation.sessionId))} reservedSeats=${reservedCount} clients=${clientCount}`,
      );

      await withTimeout(
        setColyseusRoomId(created.roomId, colyseusRoomId),
        DB_TIMEOUT_MS(),
        'setColyseusRoomId',
      );

      const clientReservation = toClientReservation(reservation);
      traceLog(
        lifecycleTraceId,
        `reservation returned to client roomId=${clientReservation.room.roomId} processId=${clientReservation.room.processId} publicAddress=${clientReservation.room.publicAddress ?? 'none'} elapsedMs=${Date.now() - startedAt}`,
      );
      respondOnce(res, 201, {
        roomId: created.roomId,
        inviteCode: created.inviteCode,
        gameType: created.gameType,
        maxPlayers: created.maxPlayers,
        colyseusRoomId,
        lifecycleTraceId,
        reservation: clientReservation,
      });
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      console.error(
        `[trace:${lifecycleTraceId}] HTTP CREATE failed elapsedMs=${elapsedMs} dbRoomId=${dbRoomId ?? 'none'} name=${safeErrorName(err)} message=${safeErrorMessage(err)}`,
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

  /**
   * Temporary authenticated diagnostic — non-sensitive room liveness snapshot.
   * Lets us inspect User A's room before User B joins.
   */
  router.get('/rooms/:roomId/debug', requireAuth, async (req, res) => {
    try {
      const roomId = String(req.params['roomId'] ?? '');
      if (!roomId || roomId.length < 8) {
        res.status(400).json({ code: ErrorCode.FORBIDDEN, message: 'Invalid room id' });
        return;
      }

      const room = await lookupRoomById(roomId);
      if (!room) {
        res.status(404).json({ code: ErrorCode.INVALID_INVITE_CODE, message: 'Room not found' });
        return;
      }

      const profile = (req as AuthedRequest).profile;
      const isMember = room.memberIds.includes(profile.userId);
      const isHost = room.hostUserId === profile.userId;
      if (!isMember && !isHost) {
        res.status(403).json({ code: ErrorCode.FORBIDDEN, message: 'Not a member of this room' });
        return;
      }

      const live = room.colyseusRoomId
        ? (matchMaker.getRoomById(room.colyseusRoomId) as unknown as
            | {
                clients?: { length: number };
                maxClients?: number;
                reservedSeats?: Record<string, unknown>;
                state?: { lifecycleTraceId?: string; phase?: string };
              }
            | undefined)
        : undefined;
      const reservedSeatCount = live?.reservedSeats ? Object.keys(live.reservedSeats).length : 0;

      res.json({
        dbStatus: room.status,
        colyseusRoomId: room.colyseusRoomId,
        matchMakerFound: !!live,
        clients: live?.clients?.length ?? 0,
        maxClients: live?.maxClients ?? room.maxPlayers,
        reservedSeatCount,
        processId: matchMaker.processId,
        pid: process.pid,
        lifecycleTraceId: live?.state?.lifecycleTraceId ?? null,
        phase: live?.state?.phase ?? null,
      });
    } catch (err) {
      console.error('[GET /rooms/:roomId/debug]', err);
      res.status(500).json({ code: ErrorCode.SERVER_ERROR, message: 'Debug lookup failed' });
    }
  });

  /**
   * Validate invite + occupancy, then reserve a Colyseus seat in the SAME room.
   * Membership is applied in onJoin (idempotent). Client must consume the reservation.
   */
  router.post('/rooms/join', requireAuth, async (req, res) => {
    const joinTrace = newLifecycleTraceId();
    try {
      if (!joinRoomLimiter.tryRemoveToken(`join:${clientKey(req)}`)) {
        res.status(429).json({ code: ErrorCode.RATE_LIMITED, message: 'Too many join attempts' });
        return;
      }

      const code = normalizeInviteCode(String(req.body?.inviteCode ?? ''));
      traceLog(joinTrace, `HTTP JOIN begin invite=${code || '(empty)'}`);
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
      const accessToken = (req as AuthedRequest).accessToken;
      const occupancyCheck = evaluateJoinOccupancy(
        room.memberIds,
        room.maxPlayers,
        profile.userId,
      );

      traceLog(
        joinTrace,
        `DB room=${shortId(room.id)} members=${room.seatsTaken} alreadyMember=${occupancyCheck.alreadyMember}`,
      );

      if (
        room.status === RoomStatus.FINISHED ||
        room.status === RoomStatus.ABANDONED ||
        room.status === RoomStatus.CANCELLED
      ) {
        res.status(410).json({ code: ErrorCode.ROOM_CLOSED, message: 'Room closed' });
        return;
      }

      if (
        (room.status === RoomStatus.PLAYING || room.status === RoomStatus.STARTING) &&
        !occupancyCheck.alreadyMember
      ) {
        res.status(409).json({
          code: ErrorCode.GAME_ALREADY_STARTED,
          message: 'Game already started',
          colyseusRoomId: room.colyseusRoomId,
        });
        return;
      }

      if (occupancyCheck.isFull) {
        res.status(409).json({ code: ErrorCode.ROOM_FULL, message: 'Room is full' });
        return;
      }

      if (!room.colyseusRoomId) {
        traceLog(joinTrace, 'DB colyseusRoomId=null → ROOM_CLOSED');
        res.status(410).json({
          code: ErrorCode.ROOM_CLOSED,
          message: 'This table is no longer available. Ask the host to create a new one.',
        });
        return;
      }

      const live = matchMaker.getRoomById(room.colyseusRoomId) as unknown as
        | {
            clients?: { length: number };
            hasReachedMaxClients?: () => boolean;
            reservedSeats?: Record<string, unknown>;
            state?: { lifecycleTraceId?: string };
          }
        | undefined;
      const clientCount = live?.clients?.length ?? 0;
      const reservedSeatCount = live?.reservedSeats ? Object.keys(live.reservedSeats).length : 0;
      const matchMakerFound = !!live;
      const roomTrace = live?.state?.lifecycleTraceId || joinTrace;
      traceLog(roomTrace, `HTTP JOIN dbRoom=${shortId(room.id)} invite=${code}`);
      traceLog(roomTrace, `DB colyseusRoomId=${room.colyseusRoomId}`);
      traceLog(
        roomTrace,
        `matchMakerFound=${matchMakerFound} clients=${clientCount} reservedSeats=${reservedSeatCount}`,
      );

      if (!live) {
        traceLog(
          roomTrace,
          `DB clearing colyseus_room_id because=join_matchMaker_miss colyseusRoomId=${room.colyseusRoomId}`,
        );
        await clearColyseusRoomIdIfMatch(room.id, room.colyseusRoomId);
        res.status(410).json({
          code: ErrorCode.ROOM_CLOSED,
          message: 'This table expired before you could join. Ask the host to create a new one.',
        });
        return;
      }

      if (!occupancyCheck.alreadyMember && live.hasReachedMaxClients?.()) {
        res.status(409).json({ code: ErrorCode.ROOM_FULL, message: 'Room is full' });
        return;
      }

      let reservation;
      try {
        reservation = await withTimeout(
          matchMaker.joinById(room.colyseusRoomId, { accessToken }),
          COLYSEUS_TIMEOUT_MS(),
          'matchMaker.joinById',
        );
      } catch (err) {
        console.error(
          `[trace:${roomTrace}] Colyseus reserve failed name=${safeErrorName(err)} message=${safeErrorMessage(err)}`,
        );
        if (isRoomNotFoundError(err)) {
          traceLog(
            roomTrace,
            `DB clearing colyseus_room_id because=joinById_room_not_found`,
          );
          await clearColyseusRoomIdIfMatch(room.id, room.colyseusRoomId);
          res.status(410).json({
            code: ErrorCode.ROOM_CLOSED,
            message: 'This table is no longer available. Ask the host to create a new one.',
          });
          return;
        }
        if (err instanceof TimeoutError) {
          res.status(504).json({ code: ErrorCode.SERVER_ERROR, message: 'Join timed out' });
          return;
        }
        const msg = safeErrorMessage(err);
        if (/full/i.test(msg)) {
          res.status(409).json({ code: ErrorCode.ROOM_FULL, message: 'Room is full' });
          return;
        }
        throw err;
      }

      const clientReservation = toClientReservation(reservation);
      traceLog(
        roomTrace,
        `guest reservation created session=${shortId(clientReservation.sessionId)} room=${clientReservation.room.roomId}`,
      );
      res.json({
        roomId: room.id,
        inviteCode: room.inviteCode,
        gameType: room.gameType,
        colyseusRoomId: room.colyseusRoomId,
        maxPlayers: room.maxPlayers,
        lifecycleTraceId: roomTrace,
        reservation: clientReservation,
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
