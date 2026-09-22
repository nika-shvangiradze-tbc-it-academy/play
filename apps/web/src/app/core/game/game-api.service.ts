import { Injectable, inject } from '@angular/core';
import { AuthService } from '../auth/auth.service';
import { environment } from '../../../environments/environment';
import type { CreateRoomResponse, GameType } from '@georgian-games/shared';

const HTTP_TIMEOUT_MS = 45_000;

@Injectable({ providedIn: 'root' })
export class GameApiService {
  private readonly auth = inject(AuthService);

  private async headers(): Promise<HeadersInit> {
    const token = this.auth.accessToken();
    if (!token) throw new Error('Not authenticated');
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit,
    timeoutMs = HTTP_TIMEOUT_MS,
  ): Promise<T> {
    const url = `${environment.gameServerHttpUrl}${path}`;
    const method = init.method ?? 'GET';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = Date.now();
    console.info('[create-room] HTTP request start', method, url);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      let body: Record<string, unknown> = {};
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        /* non-JSON error body */
      }
      console.info(
        '[create-room] HTTP response received',
        method,
        path,
        res.status,
        `elapsedMs=${Date.now() - t0}`,
      );
      if (!res.ok) {
        const message =
          typeof body['message'] === 'string'
            ? body['message']
            : `Request failed (${res.status})`;
        console.error('[game-api]', method, path, res.status, body);
        throw new Error(message);
      }
      return body as T;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        console.error('[game-api] timeout', path, url, `elapsedMs=${Date.now() - t0}`);
        throw new Error(
          'Game server timed out. It may be waking up — wait a few seconds and try again.',
        );
      }
      if (err instanceof TypeError) {
        console.error('[game-api] network', path, url, err, `elapsedMs=${Date.now() - t0}`);
        const localHint = /localhost|127\.0\.0\.1/i.test(url)
          ? ' Start the game server (repo root: npm run dev) so port 2567 is listening.'
          : '';
        throw new Error(`Cannot reach the game server.${localHint}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Lightweight readiness probe used before create/join. */
  async pingHealth(timeoutMs = 3_000): Promise<{ ok: boolean; matchMakerReady?: boolean }> {
    const url = `${environment.gameServerHttpUrl}/api/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return { ok: false };
      const body = (await res.json()) as { ok?: boolean; matchMakerReady?: boolean };
      return { ok: body.ok === true, matchMakerReady: body.matchMakerReady };
    } catch {
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  }

  async createRoom(gameType: GameType): Promise<CreateRoomResponse> {
    return this.requestJson<CreateRoomResponse>('/api/rooms', {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify({ gameType }),
    });
  }

  async joinByCode(inviteCode: string): Promise<CreateRoomResponse> {
    return this.requestJson<CreateRoomResponse>('/api/rooms/join', {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify({ inviteCode }),
    });
  }

  async lookupCode(inviteCode: string): Promise<{
    valid: boolean;
    gameType?: string;
    seatsTaken?: number;
    maxPlayers?: number;
    status?: string;
    colyseusRoomId?: string;
  }> {
    return this.requestJson(
      `/api/rooms/by-code/${encodeURIComponent(inviteCode)}`,
      { headers: await this.headers() },
    );
  }
}
