import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { GameType } from '@georgian-games/shared';
import { resetEnvCache } from '../config/env.js';

const MatchMakerState = {
  INITIALIZING: 0,
  READY: 1,
  SHUTTING_DOWN: 2,
} as const;

const handleCreateRoom = vi.fn();
const createRoom = vi.fn();
const reserveSeatFor = vi.fn();
const joinById = vi.fn();
const getHandler = vi.fn(() => ({}));
const getRoomById = vi.fn();

vi.mock('@colyseus/core', () => ({
  matchMaker: {
    MatchMakerState,
    state: MatchMakerState.READY,
    processId: 'test-process',
    getHandler,
    handleCreateRoom,
    createRoom,
    reserveSeatFor,
    joinById,
    getRoomById,
  },
}));

const authenticateToken = vi.fn();
vi.mock('../auth/verify-token.js', async () => {
  const actual = await vi.importActual<typeof import('../auth/verify-token.js')>(
    '../auth/verify-token.js',
  );
  return {
    ...actual,
    authenticateToken,
  };
});

const createGameRoom = vi.fn();
const setColyseusRoomId = vi.fn();
const abandonOrphanRoom = vi.fn();
const getRoomOccupancy = vi.fn();

vi.mock('../db/rooms.js', async () => {
  const actual = await vi.importActual<typeof import('../db/rooms.js')>('../db/rooms.js');
  return {
    ...actual,
    createGameRoom,
    setColyseusRoomId,
    abandonOrphanRoom,
    getRoomOccupancy,
    lookupRoomByInviteCode: vi.fn(),
    reserveSeat: vi.fn(),
  };
});

describe('POST /api/rooms bounded response', () => {
  beforeEach(() => {
    resetEnvCache();
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
    process.env.NODE_ENV = 'test';
    process.env.ROOMS_CREATE_AUTH_TIMEOUT_MS = '200';
    process.env.ROOMS_CREATE_DB_TIMEOUT_MS = '200';
    process.env.ROOMS_CREATE_COLYSEUS_TIMEOUT_MS = '150';

    authenticateToken.mockReset();
    createGameRoom.mockReset();
    setColyseusRoomId.mockReset();
    abandonOrphanRoom.mockReset();
    getRoomOccupancy.mockReset();
    handleCreateRoom.mockReset();
    createRoom.mockReset();
    reserveSeatFor.mockReset();
    joinById.mockReset();
    getHandler.mockReset();
    getRoomById.mockReset();
    getHandler.mockReturnValue({});
    getRoomById.mockReturnValue({ clients: [], reservedSeats: { s1: true } });
    getRoomOccupancy.mockResolvedValue({
      memberIds: ['user-1'],
      totalRows: 1,
      distinctCount: 1,
    });

    authenticateToken.mockResolvedValue({
      userId: 'user-1',
      username: 'host',
      email: undefined,
      avatarUrl: null,
    });
    createGameRoom.mockResolvedValue({
      roomId: 'db-room-1',
      inviteCode: 'ABC123',
      gameType: GameType.NARDI,
      maxPlayers: 2,
    });
    setColyseusRoomId.mockResolvedValue(undefined);
    abandonOrphanRoom.mockResolvedValue(undefined);
    handleCreateRoom.mockResolvedValue({
      roomId: 'coly-1',
      name: 'nardi',
      processId: 'test-process',
    });
    reserveSeatFor.mockResolvedValue({
      sessionId: 'sess-1',
      room: { roomId: 'coly-1', name: 'nardi', processId: 'test-process' },
    });
  });

  afterEach(() => {
    for (const key of [
      'SUPABASE_URL',
      'SUPABASE_PUBLISHABLE_KEY',
      'SUPABASE_SECRET_KEY',
      'NODE_ENV',
      'ROOMS_CREATE_AUTH_TIMEOUT_MS',
      'ROOMS_CREATE_DB_TIMEOUT_MS',
      'ROOMS_CREATE_COLYSEUS_TIMEOUT_MS',
    ]) {
      delete process.env[key];
    }
    resetEnvCache();
    vi.resetModules();
  });

  async function startApp(): Promise<{
    baseUrl: string;
    close: () => Promise<void>;
  }> {
    const { createApiRouter, resetApiRateLimitersForTests } = await import('./api.js');
    resetApiRateLimitersForTests();
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected TCP address');
    }
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    };
  }

  it('returns 201 when auth, DB, and Colyseus succeed', async () => {
    const { baseUrl, close } = await startApp();
    try {
      const res = await fetch(`${baseUrl}/api/rooms`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ gameType: GameType.NARDI }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        colyseusRoomId: string;
        inviteCode: string;
        reservation: { sessionId: string; room: { roomId: string } };
      };
      expect(body.colyseusRoomId).toBe('coly-1');
      expect(body.inviteCode).toBe('ABC123');
      expect(body.reservation.sessionId).toBe('sess-1');
      expect(body.reservation.room.roomId).toBe('coly-1');
      expect(reserveSeatFor).toHaveBeenCalled();
      expect(abandonOrphanRoom).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it('returns an error within a bounded time when Colyseus create hangs', async () => {
    handleCreateRoom.mockImplementation(
      () =>
        new Promise(() => {
          /* never settles — reproduces production hang */
        }),
    );
    const { baseUrl, close } = await startApp();
    try {
      const started = Date.now();
      const res = await fetch(`${baseUrl}/api/rooms`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ gameType: GameType.NARDI }),
      });
      const elapsed = Date.now() - started;
      expect(res.status).toBe(504);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.message).toMatch(/timed out/i);
      expect(elapsed).toBeLessThan(2_000);
      expect(abandonOrphanRoom).toHaveBeenCalledWith('db-room-1');
    } finally {
      await close();
    }
  });

  it('returns an error within a bounded time when DB create hangs', async () => {
    createGameRoom.mockImplementation(
      () =>
        new Promise(() => {
          /* never settles */
        }),
    );
    const { baseUrl, close } = await startApp();
    try {
      const started = Date.now();
      const res = await fetch(`${baseUrl}/api/rooms`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ gameType: GameType.NARDI }),
      });
      const elapsed = Date.now() - started;
      expect(res.status).toBe(504);
      expect(elapsed).toBeLessThan(2_000);
      expect(handleCreateRoom).not.toHaveBeenCalled();
      expect(abandonOrphanRoom).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
});
