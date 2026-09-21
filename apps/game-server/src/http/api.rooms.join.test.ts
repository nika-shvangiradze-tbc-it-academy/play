import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { GameType, ErrorCode } from '@georgian-games/shared';
import { resetEnvCache } from '../config/env.js';

const MatchMakerState = {
  INITIALIZING: 0,
  READY: 1,
  SHUTTING_DOWN: 2,
} as const;

const handleCreateRoom = vi.fn();
const getHandler = vi.fn(() => ({}));
const getRoomById = vi.fn();

vi.mock('@colyseus/core', () => ({
  matchMaker: {
    MatchMakerState,
    state: MatchMakerState.READY,
    processId: 'test-process',
    getHandler,
    handleCreateRoom,
    createRoom: vi.fn(),
    getRoomById,
  },
}));

const authenticateToken = vi.fn();
vi.mock('../auth/verify-token.js', async () => {
  const actual = await vi.importActual<typeof import('../auth/verify-token.js')>(
    '../auth/verify-token.js',
  );
  return { ...actual, authenticateToken };
});

const createGameRoom = vi.fn();
const setColyseusRoomId = vi.fn();
const abandonOrphanRoom = vi.fn();
const getRoomOccupancy = vi.fn();
const lookupRoomByInviteCode = vi.fn();
const ensureRoomMembership = vi.fn();

vi.mock('../db/rooms.js', async () => {
  const actual = await vi.importActual<typeof import('../db/rooms.js')>('../db/rooms.js');
  return {
    ...actual,
    createGameRoom,
    setColyseusRoomId,
    abandonOrphanRoom,
    getRoomOccupancy,
    lookupRoomByInviteCode,
    ensureRoomMembership,
    reserveSeat: vi.fn(),
  };
});

const hostId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const guestId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const thirdId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

describe('multiplayer room join lifecycle (HTTP)', () => {
  beforeEach(() => {
    resetEnvCache();
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
    process.env.NODE_ENV = 'test';
    process.env.ROOMS_CREATE_AUTH_TIMEOUT_MS = '500';
    process.env.ROOMS_CREATE_DB_TIMEOUT_MS = '500';
    process.env.ROOMS_CREATE_COLYSEUS_TIMEOUT_MS = '500';

    authenticateToken.mockReset();
    createGameRoom.mockReset();
    setColyseusRoomId.mockReset();
    abandonOrphanRoom.mockReset();
    getRoomOccupancy.mockReset();
    lookupRoomByInviteCode.mockReset();
    ensureRoomMembership.mockReset();
    handleCreateRoom.mockReset();
    getRoomById.mockReset();
    getHandler.mockReturnValue({});

    handleCreateRoom.mockResolvedValue({ roomId: 'coly-1' });
    setColyseusRoomId.mockResolvedValue(undefined);
    abandonOrphanRoom.mockResolvedValue(undefined);
    getRoomById.mockReturnValue({
      clients: [],
      hasReachedMaxClients: () => false,
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

  async function startApp() {
    const { createApiRouter, resetApiRateLimitersForTests } = await import('./api.js');
    resetApiRateLimitersForTests();
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    };
  }

  function asUser(userId: string) {
    authenticateToken.mockResolvedValue({
      userId,
      username: userId.slice(0, 4),
      email: undefined,
      avatarUrl: null,
    });
  }

  it('Test A+B: create then guest join succeeds at 1/2 without HTTP seat insert', async () => {
    createGameRoom.mockResolvedValue({
      roomId: 'db-1',
      inviteCode: 'ABC234',
      gameType: GameType.NARDI,
      maxPlayers: 2,
    });
    getRoomOccupancy.mockResolvedValue({
      memberIds: [hostId],
      totalRows: 1,
      distinctCount: 1,
    });

    const { baseUrl, close } = await startApp();
    try {
      asUser(hostId);
      const createRes = await fetch(`${baseUrl}/api/rooms`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer t',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ gameType: GameType.NARDI }),
      });
      expect(createRes.status).toBe(201);

      lookupRoomByInviteCode.mockResolvedValue({
        id: 'db-1',
        inviteCode: 'ABC234',
        gameType: GameType.NARDI,
        status: 'waiting',
        maxPlayers: 2,
        hostUserId: hostId,
        colyseusRoomId: 'coly-1',
        seatsTaken: 1,
        memberIds: [hostId],
      });

      asUser(guestId);
      const joinRes = await fetch(`${baseUrl}/api/rooms/join`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer t',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inviteCode: 'ABC234' }),
      });
      expect(joinRes.status).toBe(200);
      const body = (await joinRes.json()) as { colyseusRoomId: string };
      expect(body.colyseusRoomId).toBe('coly-1');
      // No HTTP membership insert — ensureRoomMembership is Colyseus-only.
      expect(ensureRoomMembership).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it('Test C: third player gets ROOM_FULL', async () => {
    lookupRoomByInviteCode.mockResolvedValue({
      id: 'db-1',
      inviteCode: 'ABC234',
      gameType: GameType.NARDI,
      status: 'waiting',
      maxPlayers: 2,
      hostUserId: hostId,
      colyseusRoomId: 'coly-1',
      seatsTaken: 2,
      memberIds: [hostId, guestId],
    });
    asUser(thirdId);
    const { baseUrl, close } = await startApp();
    try {
      const joinRes = await fetch(`${baseUrl}/api/rooms/join`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer t',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inviteCode: 'ABC234' }),
      });
      expect(joinRes.status).toBe(409);
      const body = (await joinRes.json()) as { code: string };
      expect(body.code).toBe(ErrorCode.ROOM_FULL);
    } finally {
      await close();
    }
  });

  it('Test D: host retry/reconnect is allowed (alreadyMember)', async () => {
    lookupRoomByInviteCode.mockResolvedValue({
      id: 'db-1',
      inviteCode: 'ABC234',
      gameType: GameType.NARDI,
      status: 'waiting',
      maxPlayers: 2,
      hostUserId: hostId,
      colyseusRoomId: 'coly-1',
      seatsTaken: 1,
      memberIds: [hostId],
    });
    asUser(hostId);
    const { baseUrl, close } = await startApp();
    try {
      const joinRes = await fetch(`${baseUrl}/api/rooms/join`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer t',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inviteCode: 'ABC234' }),
      });
      expect(joinRes.status).toBe(200);
    } finally {
      await close();
    }
  });

  it('Test F: guest can retry after failed WS (still only host in DB)', async () => {
    lookupRoomByInviteCode.mockResolvedValue({
      id: 'db-1',
      inviteCode: 'ABC234',
      gameType: GameType.NARDI,
      status: 'waiting',
      maxPlayers: 2,
      hostUserId: hostId,
      colyseusRoomId: 'coly-1',
      seatsTaken: 1,
      memberIds: [hostId],
    });
    asUser(guestId);
    const { baseUrl, close } = await startApp();
    try {
      const first = await fetch(`${baseUrl}/api/rooms/join`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer t',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inviteCode: 'ABC234' }),
      });
      expect(first.status).toBe(200);
      // Simulate failed WS: DB unchanged. Second HTTP join still OK.
      const second = await fetch(`${baseUrl}/api/rooms/join`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer t',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inviteCode: 'ABC234' }),
      });
      expect(second.status).toBe(200);
    } finally {
      await close();
    }
  });
});
