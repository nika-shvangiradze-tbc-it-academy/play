import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import express from 'express';
import { Server, matchMaker, Room, type Client } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client as ColyseusClient } from 'colyseus.js';
import { GameType, ErrorCode } from '@georgian-games/shared';
import { resetEnvCache } from '../config/env.js';

class TestNardiRoom extends Room {
  maxClients = 2;

  onCreate(options: { maxPlayers?: number; dbRoomId?: string }): void {
    this.maxClients = options.maxPlayers ?? 2;
    this.setMetadata(options ?? {});
    void this.setPrivate(true);
    this.setSeatReservationTime(45);
    console.log(`[nardi:onCreate] roomId=${this.roomId}`);
  }

  onAuth(_client: Client, options: { accessToken?: string }) {
    if (!options?.accessToken) throw new Error('missing token');
    const userId = options.accessToken;
    return { userId, username: userId.slice(0, 4) };
  }

  onJoin(client: Client, _opts: unknown, auth?: { userId: string }) {
    console.log(`[nardi:onJoin] user=${auth?.userId?.slice(0, 8)} clients=${this.clients.length}/2`);
  }

  onDispose() {
    console.log(`[nardi:onDispose] roomId=${this.roomId} clients=${this.clients.length}`);
  }
}

const hostToken = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const guestToken = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const thirdToken = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

describe('Colyseus seat reservation lifecycle', () => {
  let baseUrl = '';
  let wsUrl = '';
  let closeAll: (() => Promise<void>) | undefined;
  let createdColyseusId: string | undefined;
  const members = new Map<string, string[]>();

  beforeAll(async () => {
    resetEnvCache();
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
    process.env.NODE_ENV = 'test';

    vi.resetModules();
    vi.doMock('../auth/verify-token.js', async () => {
      const actual = await vi.importActual<typeof import('../auth/verify-token.js')>(
        '../auth/verify-token.js',
      );
      return {
        ...actual,
        authenticateToken: vi.fn().mockImplementation(async (token: string) => ({
          userId: token,
          username: token.slice(0, 4),
          email: undefined,
          avatarUrl: null,
        })),
      };
    });

    vi.doMock('../db/rooms.js', async () => {
      const actual = await vi.importActual<typeof import('../db/rooms.js')>('../db/rooms.js');
      return {
        ...actual,
        createGameRoom: vi.fn().mockImplementation(async (hostUserId: string) => {
          const roomId = 'db-res-1';
          members.set(roomId, [hostUserId]);
          return {
            roomId,
            inviteCode: 'ABCDEF',
            gameType: GameType.NARDI,
            maxPlayers: 2,
          };
        }),
        setColyseusRoomId: vi.fn().mockImplementation(async (_dbId: string, colyId: string) => {
          createdColyseusId = colyId;
        }),
        clearColyseusRoomIdIfMatch: vi.fn().mockResolvedValue(undefined),
        abandonOrphanRoom: vi.fn().mockResolvedValue(undefined),
        getRoomOccupancy: vi.fn().mockImplementation(async (roomId: string) => {
          const ids = members.get(roomId) ?? [];
          return { memberIds: ids, totalRows: ids.length, distinctCount: ids.length };
        }),
        lookupRoomByInviteCode: vi.fn().mockImplementation(async () => {
          const ids = members.get('db-res-1') ?? [];
          return {
            id: 'db-res-1',
            inviteCode: 'ABCDEF',
            gameType: GameType.NARDI,
            status: 'waiting',
            maxPlayers: 2,
            hostUserId: hostToken,
            colyseusRoomId: createdColyseusId ?? null,
            seatsTaken: ids.length,
            memberIds: ids,
          };
        }),
        ensureRoomMembership: vi.fn().mockImplementation(async (roomId: string, userId: string) => {
          const ids = members.get(roomId) ?? [];
          if (!ids.includes(userId)) {
            ids.push(userId);
            members.set(roomId, ids);
          }
          return 'created';
        }),
      };
    });

    const { createApiRouter, resetApiRateLimitersForTests } = await import('./api.js');
    resetApiRateLimitersForTests();

    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());

    const httpServer = createServer(app);
    const gameServer = new Server({
      transport: new WebSocketTransport({ server: httpServer }),
      greet: false,
      selectProcessIdToCreateRoom: async () => matchMaker.processId,
    });
    gameServer.define('nardi', TestNardiRoom);
    await gameServer.listen(0);

    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
    wsUrl = `ws://127.0.0.1:${address.port}`;

    closeAll = async () => {
      await gameServer.gracefullyShutdown(false);
    };
  }, 30_000);

  afterAll(async () => {
    await closeAll?.();
    vi.doUnmock('../auth/verify-token.js');
    vi.doUnmock('../db/rooms.js');
    vi.resetModules();
    for (const key of [
      'SUPABASE_URL',
      'SUPABASE_PUBLISHABLE_KEY',
      'SUPABASE_SECRET_KEY',
      'NODE_ENV',
    ]) {
      delete process.env[key];
    }
    resetEnvCache();
  });

  it('A–E: create reservation → creator connects → guest joins same room → third FULL', async () => {
    // A: POST create returns reservation; creator can consume immediately
    const createRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${hostToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ gameType: GameType.NARDI }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      colyseusRoomId: string;
      reservation: { sessionId: string; room: { roomId: string; name: string; processId: string } };
      inviteCode: string;
    };
    expect(created.reservation.sessionId).toBeTruthy();
    expect(created.reservation.room.roomId).toBe(created.colyseusRoomId);

    // B: room alive while reservation valid
    expect(matchMaker.getRoomById(created.colyseusRoomId)).toBeTruthy();

    const hostClient = new ColyseusClient(wsUrl);
    const hostRoom = await hostClient.consumeSeatReservation(created.reservation);
    expect(hostRoom.roomId).toBe(created.colyseusRoomId);

    // C: clients = 1
    const liveAfterHost = matchMaker.getRoomById(created.colyseusRoomId);
    expect(liveAfterHost?.clients.length).toBe(1);

    // Simulate onJoin membership for guest occupancy checks
    members.set('db-res-1', [hostToken]);

    // D: User B joins by invite → same Colyseus room
    const joinRes = await fetch(`${baseUrl}/api/rooms/join`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${guestToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inviteCode: 'ABCDEF' }),
    });
    expect(joinRes.status).toBe(200);
    const joined = (await joinRes.json()) as {
      colyseusRoomId: string;
      reservation: { sessionId: string; room: { roomId: string; name: string; processId: string } };
    };
    expect(joined.colyseusRoomId).toBe(created.colyseusRoomId);
    expect(joined.reservation.room.roomId).toBe(created.colyseusRoomId);

    const guestClient = new ColyseusClient(wsUrl);
    const guestRoom = await guestClient.consumeSeatReservation(joined.reservation);
    expect(guestRoom.roomId).toBe(created.colyseusRoomId);

    const liveAfterGuest = matchMaker.getRoomById(created.colyseusRoomId);
    expect(liveAfterGuest?.clients.length).toBe(2);

    members.set('db-res-1', [hostToken, guestToken]);

    // E: User C → ROOM_FULL
    const thirdRes = await fetch(`${baseUrl}/api/rooms/join`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${thirdToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inviteCode: 'ABCDEF' }),
    });
    expect(thirdRes.status).toBe(409);
    const thirdBody = (await thirdRes.json()) as { code: string };
    expect(thirdBody.code).toBe(ErrorCode.ROOM_FULL);

    await hostRoom.leave(true);
    await guestRoom.leave(true);
  }, 30_000);

  it('G: disposed room clears usable mapping path (join returns ROOM_CLOSED)', async () => {
    createdColyseusId = 'dead-room-id';
    members.set('db-res-1', [hostToken]);

    const joinRes = await fetch(`${baseUrl}/api/rooms/join`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${guestToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inviteCode: 'ABCDEF' }),
    });
    expect(joinRes.status).toBe(410);
    const body = (await joinRes.json()) as { code: string; message: string };
    expect(body.code).toBe(ErrorCode.ROOM_CLOSED);
    expect(body.message).not.toMatch(/not found/i);
  });
});
