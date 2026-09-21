import { Injectable, inject } from '@angular/core';
import { AuthService } from '../auth/auth.service';
import { environment } from '../../../environments/environment';
import type { CreateRoomResponse, GameType } from '@georgian-games/shared';

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

  async createRoom(gameType: GameType): Promise<CreateRoomResponse> {
    const res = await fetch(`${environment.gameServerHttpUrl}/api/rooms`, {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify({ gameType }),
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.message ?? 'Failed to create room');
    }
    return body as CreateRoomResponse;
  }

  async joinByCode(inviteCode: string): Promise<CreateRoomResponse> {
    const res = await fetch(`${environment.gameServerHttpUrl}/api/rooms/join`, {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify({ inviteCode }),
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.message ?? 'Failed to join room');
    }
    return body as CreateRoomResponse;
  }

  async lookupCode(inviteCode: string): Promise<{
    valid: boolean;
    gameType?: string;
    seatsTaken?: number;
    maxPlayers?: number;
    status?: string;
    colyseusRoomId?: string;
  }> {
    const res = await fetch(
      `${environment.gameServerHttpUrl}/api/rooms/by-code/${encodeURIComponent(inviteCode)}`,
      { headers: await this.headers() },
    );
    return res.json();
  }
}
