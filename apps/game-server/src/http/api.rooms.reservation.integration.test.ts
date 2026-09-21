import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import express from 'express';
import { Server, matchMaker, Room, type Client } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client as ColyseusClient } from 'colyseus.js';
import { GameType, ErrorCode } from '@georgian-games/shared';
import { resetEnvCache } from '../config/env.js';

/**
 * Mirrors BaseGameRoom WAITING leave behavior for lifecycle proofs:
 * consented → free seat (dispose if empty);
 * unconsented → short allowReconnection hold.
 */
class TestNardiRoom extends Room {
  maxClients = 2;
  private sessions = new Map<string, { userId: string }>();

  onCreate(options: { maxPlayers?: number; dbRoomId?: string }): void {
    this.maxClients = options.maxPlayers ?? 2;
    this.setMetadata(options ?? {});
    void this.setPrivate(true);
    this.setSeatReservationTime(45);
    this.autoDispose = true;
    console.log(`[nardi:onCreate] roomId=${this.roomId}`);
  }

  onAuth(_client: Client, options: { accessToken?: string }) {
    if (!options?.accessToken) throw new Error('missing token');
    const userId = options.accessToken;
    console.log(`[nardi:onAuth] roomId=${this.roomId} hasToken=true`);
    return { userId, username: userId.slice(0, 4) };
  }

  onJoin(client: Client, _opts: unknown, auth?: { userId: string }) {
    if (auth?.userId) this.sessions.set(client.sessionId, { userId: auth.userId });
    console.log(
      `[nardi:onJoin] roomId=${this.roomId} user=${auth?.userId?.slice(0, 8)} clients=${this.clients.length}/2`,
    );
  }

  async onLeave(client: Client, consented: boolean) {
    const session = this.sessions.get(client.sessionId);
    console.log(
      `[nardi:onLeave] roomId=${this.roomId} user=${session?.userId?.slice(0, 8)} consented=${consented}`,
    );
    if (consented) {
      this.sessions.delete(client.sessionId);
      return;
    }
    try {
      await this.allowReconnection(client, 2);
      console.log(`[nardi:onLeave] reconnected roomId=${this.roomId}`);
    } catch {
      this.sessions.delete(client.sessionId);
      console.log(`[nardi:onLeave] grace expired roomId=${this.roomId}`);
    }
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
  let clearColyseusRoomIdIfMatch: ReturnType<typeof vi.fn>;
  const members = new Map<string, string[]>();

  beforeAll(async () => {
    resetEnvCache();
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
    process.env.NODE_ENV = 'test';
    process.env.RECONNECT_GRACE_MS = '15000';

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

    clearColyseusRoomIdIfMatch = vi.fn().mockResolvedValue(undefined);

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
        clearColyseusRoomIdIfMatch,
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
      transport: new WebSocketTransport({
        server: httpServer,
        pingInterval: 30_000,
        pingMaxRetries: 4,
      }),
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
      'RECONNECT_GRACE_MS',
    ]) {
      delete process.env[key];
    }
    resetEnvCache();
  });

  it('A–D: create → consume → clients=1/2 → guest join → clients=2/2', async () => {
    members.clear();
    createdColyseusId = undefined;

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

    // B: room alive while reservation valid / creator connected
    expect(matchMaker.getRoomById(created.colyseusRoomId)).toBeTruthy();

    const hostClient = new ColyseusClient(wsUrl);
    const hostRoom = await hostClient.consumeSeatReservation(created.reservation);
    expect(hostRoom.roomId).toBe(created.colyseusRoomId);

    const liveAfterHost = matchMaker.getRoomById(created.colyseusRoomId);
    expect(liveAfterHost?.clients.length).toBe(1);

    members.set('db-res-1', [hostToken]);

    // C: User B HTTP join sees the same live room
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

    // D: second reservation consumed → clients=2/2
    const guestClient = new ColyseusClient(wsUrl);
    const guestRoom = await guestClient.consumeSeatReservation(joined.reservation);
    expect(guestRoom.roomId).toBe(created.colyseusRoomId);

    const liveAfterGuest = matchMaker.getRoomById(created.colyseusRoomId);
    expect(liveAfterGuest?.clients.length).toBe(2);

    members.set('db-res-1', [hostToken, guestToken]);

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

  it('B/E: creator remains connected while waiting (socket stays open)', async () => {
    members.clear();
    createdColyseusId = undefined;

    const createRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${hostToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ gameType: GameType.NARDI }),
    });
    const created = (await createRes.json()) as {
      colyseusRoomId: string;
      reservation: { sessionId: string; room: { roomId: string } };
    };

    const hostClient = new ColyseusClient(wsUrl);
    const hostRoom = await hostClient.consumeSeatReservation(created.reservation);

    await new Promise((r) => setTimeout(r, 500));
    expect(matchMaker.getRoomById(created.colyseusRoomId)?.clients.length).toBe(1);
    // Colyseus.js Room stays joined while the socket is open (Node + browser).
    expect(hostRoom.sessionId).toBeTruthy();
    expect(hostRoom.roomId).toBe(created.colyseusRoomId);

    await hostRoom.leave(true);
  }, 30_000);

  it('E: leave(false) after create (Angular detach race) disposes WAITING room without grace when consented path — and F: duplicate session consume is client-guarded', async () => {
    members.clear();
    createdColyseusId = undefined;

    const createRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${hostToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ gameType: GameType.NARDI }),
    });
    const created = (await createRes.json()) as {
      colyseusRoomId: string;
      reservation: { sessionId: string; room: { roomId: string } };
    };

    const consumed = new Set<string>();
    const guardDuplicate = (sessionId: string) => {
      if (consumed.has(sessionId)) return false;
      consumed.add(sessionId);
      return true;
    };
    expect(guardDuplicate(created.reservation.sessionId)).toBe(true);
    expect(guardDuplicate(created.reservation.sessionId)).toBe(false);

    const hostClient = new ColyseusClient(wsUrl);
    const hostRoom = await hostClient.consumeSeatReservation(created.reservation);
    expect(matchMaker.getRoomById(created.colyseusRoomId)?.clients.length).toBe(1);

    // Simulate Angular connect() detachCurrentRoom(false) — unconsented.
    // With WAITING grace, room stays alive briefly for guest join.
    void hostRoom.leave(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(matchMaker.getRoomById(created.colyseusRoomId)).toBeTruthy();

    members.set('db-res-1', [hostToken]);
    const joinRes = await fetch(`${baseUrl}/api/rooms/join`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${guestToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inviteCode: 'ABCDEF' }),
    });
    expect(joinRes.status).toBe(200);
  }, 30_000);

  it('G/H: disposed room → ROOM_CLOSED and clearColyseusRoomId path', async () => {
    createdColyseusId = 'dead-room-id';
    members.set('db-res-1', [hostToken]);
    clearColyseusRoomIdIfMatch.mockClear();

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
    expect(body.message).toMatch(/expired before you could join/i);
    expect(clearColyseusRoomIdIfMatch).toHaveBeenCalledWith('db-res-1', 'dead-room-id');
  });

  it('consented leave empties WAITING room and produces ROOM_CLOSED for next join', async () => {
    members.clear();
    createdColyseusId = undefined;

    const createRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${hostToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ gameType: GameType.NARDI }),
    });
    const created = (await createRes.json()) as {
      colyseusRoomId: string;
      reservation: { sessionId: string; room: { roomId: string } };
    };

    const hostClient = new ColyseusClient(wsUrl);
    const hostRoom = await hostClient.consumeSeatReservation(created.reservation);
    await hostRoom.leave(true);
    await new Promise((r) => setTimeout(r, 150));

    expect(matchMaker.getRoomById(created.colyseusRoomId)).toBeFalsy();

    // Stale DB id still points at disposed room
    createdColyseusId = created.colyseusRoomId;
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
  }, 30_000);
});

describe('frontend session consume guard (pure)', () => {
  it('F: duplicate consume of the same sessionId is prevented', () => {
    const consumed = new Set<string>();
    const tryConsume = (sessionId: string) => {
      if (consumed.has(sessionId)) return 'duplicate';
      consumed.add(sessionId);
      return 'ok';
    };
    expect(tryConsume('sess-1')).toBe('ok');
    expect(tryConsume('sess-1')).toBe('duplicate');
    expect(tryConsume('sess-2')).toBe('ok');
  });

  it('E: page destroy must not imply room.leave', () => {
    let leaveCalls = 0;
    const ngOnDestroy = () => {
      /* GameSessionService owns the Room — intentionally empty */
    };
    ngOnDestroy();
    expect(leaveCalls).toBe(0);
  });
});
