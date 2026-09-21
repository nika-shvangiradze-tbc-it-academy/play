import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import express from 'express';
import { Server, matchMaker, Room } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { GameType } from '@georgian-games/shared';
import { resetEnvCache } from '../config/env.js';

class TestNardiRoom extends Room {
  onCreate(options: { maxPlayers?: number }): void {
    this.maxClients = options.maxPlayers ?? 2;
    this.setMetadata(options ?? {});
  }
}

/**
 * Proves Express POST /api/rooms + matchMaker.createRoom work together when
 * Server.define + gameServer.listen (accept) run in the correct order.
 */
describe('POST /api/rooms + Colyseus bootstrap integration', () => {
  let baseUrl = '';
  let closeAll: (() => Promise<void>) | undefined;

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
        authenticateToken: vi.fn().mockResolvedValue({
          userId: 'user-1',
          username: 'host',
          email: undefined,
          avatarUrl: null,
        }),
      };
    });
    vi.doMock('../db/rooms.js', async () => {
      const actual = await vi.importActual<typeof import('../db/rooms.js')>('../db/rooms.js');
      return {
        ...actual,
        createGameRoom: vi.fn().mockResolvedValue({
          roomId: 'db-room-int',
          inviteCode: 'ZZZZZZ',
          gameType: GameType.NARDI,
          maxPlayers: 2,
        }),
        setColyseusRoomId: vi.fn().mockResolvedValue(undefined),
        abandonOrphanRoom: vi.fn().mockResolvedValue(undefined),
        getRoomOccupancy: vi.fn().mockResolvedValue({
          memberIds: ['user-1'],
          totalRows: 1,
          distinctCount: 1,
        }),
        lookupRoomByInviteCode: vi.fn(),
        reserveSeat: vi.fn(),
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
    if (!address || typeof address === 'string') {
      throw new Error('expected TCP address');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

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

  it('creates a Colyseus room and responds successfully within a bound', async () => {
    expect(matchMaker.state).toBe(matchMaker.MatchMakerState.READY);
    matchMaker.getHandler('nardi');

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
    expect(elapsed).toBeLessThan(5_000);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { colyseusRoomId: string };
    expect(body.colyseusRoomId).toBeTruthy();
    expect(matchMaker.getRoomById(body.colyseusRoomId)).toBeTruthy();
  });
});
