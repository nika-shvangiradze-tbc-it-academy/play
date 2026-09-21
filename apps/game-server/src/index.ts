import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { getEnv, isDev } from './config/env.js';
import { createApiRouter } from './http/api.js';
import { NardiRoom } from './rooms/NardiRoom.js';

async function main(): Promise<void> {
  const env = getEnv();
  const app = express();
  app.use(
    cors({
      origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', createApiRouter());

  const httpServer = createServer(app);
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
  });

  gameServer.define('nardi', NardiRoom);

  httpServer.listen(env.PORT, () => {
    console.log(`[game-server] listening on :${env.PORT}`);
    if (isDev()) {
      console.log(`[game-server] CORS origin=${env.CORS_ORIGIN}`);
    }
  });
}

main().catch((err) => {
  console.error('[game-server] fatal', err);
  process.exit(1);
});
