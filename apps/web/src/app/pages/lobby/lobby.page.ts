import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { GAME_CATALOG, GameType, normalizeInviteCode } from '@georgian-games/shared';
import { GameApiService } from '../../core/game/game-api.service';
import { GameSessionService } from '../../core/game/game-session.service';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-lobby-page',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './lobby.page.html',
  styleUrl: './lobby.page.scss',
})
export class LobbyPage {
  private readonly api = inject(GameApiService);
  private readonly session = inject(GameSessionService);
  private readonly router = inject(Router);

  readonly games = GAME_CATALOG;
  readonly GameType = GameType;

  joinCode = '';
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  readonly nardiMode = signal<'menu' | 'create-join'>('menu');
  private createInFlight = false;

  selectNardi(): void {
    this.nardiMode.set('create-join');
    this.error.set(null);
  }

  backToGames(): void {
    this.nardiMode.set('menu');
  }

  async createTable(): Promise<void> {
    if (this.createInFlight || this.busy()) return;
    this.createInFlight = true;
    this.busy.set(true);
    this.error.set(null);
    try {
      console.info(
        '[create-room] UI click',
        environment.gameServerHttpUrl,
        environment.gameServerWsUrl,
      );
      const health = await this.api.pingHealth();
      if (!health.ok) {
        throw new Error(
          'Game server is not reachable on ' +
            environment.gameServerHttpUrl +
            '. From the repo root run `npm run dev` (web + server), or `npm run dev -w @georgian-games/game-server`.',
        );
      }
      if (health.matchMakerReady === false) {
        throw new Error('Game server is up but matchMaker is not READY yet — try again in a moment.');
      }
      console.info('[create-room] health ok → POST /api/rooms');
      const room = await this.api.createRoom(GameType.NARDI);
      if (!room?.reservation?.sessionId || !room.reservation.room?.roomId) {
        throw new Error('Server created the table but returned no seat reservation');
      }
      console.info('[create-room] frontend response received', room.inviteCode, room.lifecycleTraceId);
      await this.session.enterWithReservation(room.reservation, {
        dbRoomId: room.roomId,
        inviteCode: room.inviteCode,
        gameType: room.gameType,
        role: 'host',
        lifecycleTraceId: room.lifecycleTraceId,
      });
      if (!this.session.socketOpen()) {
        throw new Error('Connected to the table but the WebSocket closed immediately');
      }
      console.info('[create-room] navigating', room.inviteCode);
      await this.router.navigate(['/room', room.inviteCode]);
    } catch (err) {
      console.error('[create-room] failed', err);
      this.error.set(err instanceof Error ? err.message : 'Could not create table');
    } finally {
      this.busy.set(false);
      this.createInFlight = false;
    }
  }

  async joinTable(): Promise<void> {
    const code = normalizeInviteCode(this.joinCode);
    if (!code) {
      this.error.set('Enter an invite code');
      return;
    }
    if (this.createInFlight || this.busy()) return;
    this.createInFlight = true;
    this.busy.set(true);
    this.error.set(null);
    try {
      const health = await this.api.pingHealth();
      if (!health.ok) {
        throw new Error(
          'Game server is not reachable on ' +
            environment.gameServerHttpUrl +
            '. From the repo root run `npm run dev`.',
        );
      }
      console.info('[lobby] joinTable → POST /api/rooms/join', code);
      const room = await this.api.joinByCode(code);
      if (!room?.reservation?.sessionId || !room.reservation.room?.roomId) {
        throw new Error('Server accepted the join but returned no seat reservation');
      }
      await this.session.enterWithReservation(room.reservation, {
        dbRoomId: room.roomId,
        inviteCode: room.inviteCode,
        gameType: room.gameType,
        role: 'guest',
        lifecycleTraceId: room.lifecycleTraceId,
      });
      if (!this.session.socketOpen()) {
        throw new Error('Joined the table but the WebSocket closed immediately');
      }
      await this.router.navigate(['/room', room.inviteCode]);
    } catch (err) {
      console.error('[lobby] joinTable failed', err);
      this.error.set(err instanceof Error ? err.message : 'Could not join table');
    } finally {
      this.busy.set(false);
      this.createInFlight = false;
    }
  }
}
