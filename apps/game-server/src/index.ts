import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { getEnv, isDev, logSupabaseKeyConfigOnce } from './config/env.js';
import { createCorsOptions } from './config/cors.js';
import { createApiRouter } from './http/api.js';
import { NardiRoom } from './rooms/NardiRoom.js';

async function main(): Promise<void> {
  const env = getEnv();
  logSupabaseKeyConfigOnce();

  const webConcurrency = process.env['WEB_CONCURRENCY'];
  if (webConcurrency && Number(webConcurrency) > 1) {
    console.error(
      `[game-server] WEB_CONCURRENCY=${webConcurrency} is unsafe for process-local matchMaker. Set WEB_CONCURRENCY=1.`,
    );
  }

  const app = express();

  // CORS must run before routes so preflight OPTIONS and auth errors still get headers.
  app.use(cors(createCorsOptions(env.CORS_ORIGINS)));
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', createApiRouter());

  const httpServer = createServer(app);
  const gameServer = new Server({
    // Required so seat reservations advertise the public host clients actually use.
    ...(env.PUBLIC_ADDRESS ? { publicAddress: env.PUBLIC_ADDRESS } : {}),
    transport: new WebSocketTransport({
      server: httpServer,
      // Render/proxies can drop aggressive ping/pong; keep alive without false terminates.
      pingInterval: 30_000,
      pingMaxRetries: 4,
    }),
    // Single-node: always create rooms on this process (skip presence IPC selection).
    selectProcessIdToCreateRoom: async () => matchMaker.processId,
  });

  gameServer.define('nardi', NardiRoom);

  // Must use gameServer.listen so matchMaker.accept() runs (IPC / READY state).
  // Calling httpServer.listen alone leaves matchmaking half-initialized.
  await gameServer.listen(env.PORT);
  console.log(
    `[startup] pid=${process.pid} processId=${matchMaker.processId} port=${env.PORT}`,
  );
  console.log(
    `[game-server] matchMaker state=${String(matchMaker.state)} nardi=${
      matchMaker.getHandler('nardi') ? 'yes' : 'no'
    }`,
  );
  if (env.PUBLIC_ADDRESS) {
    console.log(`[game-server] publicAddress=${env.PUBLIC_ADDRESS}`);
  }
  if (isDev()) {
    console.log(`[game-server] CORS origins=${env.CORS_ORIGINS.join(',')}`);
  }
}

main().catch((err) => {
  console.error('[game-server] fatal', err);
  process.exit(1);
});
