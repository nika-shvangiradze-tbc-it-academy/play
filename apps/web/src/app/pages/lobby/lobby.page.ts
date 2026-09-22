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
          'თამაშის სერვერი მიუწვდომელია (' +
            environment.gameServerHttpUrl +
            '). გაუშვი საცავის ფესვიდან `npm run dev` (ვები + სერვერი).',
        );
      }
      if (health.matchMakerReady === false) {
        throw new Error('სერვერი ჩართულია, მაგრამ მატჩმეიკერი ჯერ მზად არ არის — სცადე ცოტა ხანში.');
      }
      console.info('[create-room] health ok → POST /api/rooms');
      const room = await this.api.createRoom(GameType.NARDI);
      if (!room?.reservation?.sessionId || !room.reservation.room?.roomId) {
        throw new Error('სერვერმა მაგიდა შექმნა, მაგრამ ადგილი არ დაბრუნდა');
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
        throw new Error('მაგიდასთან დაკავშირება მოხდა, მაგრამ კავშირი მაშინვე გაწყდა');
      }
      console.info('[create-room] navigating', room.inviteCode);
      await this.router.navigate(['/room', room.inviteCode]);
    } catch (err) {
      console.error('[create-room] failed', err);
      this.error.set(err instanceof Error ? err.message : 'მაგიდის შექმნა ვერ მოხერხდა');
    } finally {
      this.busy.set(false);
      this.createInFlight = false;
    }
  }

  async joinTable(): Promise<void> {
    const code = normalizeInviteCode(this.joinCode);
    if (!code) {
      this.error.set('შეიყვანე მოწვევის კოდი');
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
          'თამაშის სერვერი მიუწვდომელია (' +
            environment.gameServerHttpUrl +
            '). გაუშვი საცავის ფესვიდან `npm run dev`.',
        );
      }
      console.info('[lobby] joinTable → POST /api/rooms/join', code);
      const room = await this.api.joinByCode(code);
      if (!room?.reservation?.sessionId || !room.reservation.room?.roomId) {
        throw new Error('სერვერმა მიერთება მიიღო, მაგრამ ადგილი არ დაბრუნდა');
      }
      await this.session.enterWithReservation(room.reservation, {
        dbRoomId: room.roomId,
        inviteCode: room.inviteCode,
        gameType: room.gameType,
        role: 'guest',
        lifecycleTraceId: room.lifecycleTraceId,
      });
      if (!this.session.socketOpen()) {
        throw new Error('მაგიდასთან მიერთება მოხდა, მაგრამ კავშირი მაშინვე გაწყდა');
      }
      await this.router.navigate(['/room', room.inviteCode]);
    } catch (err) {
      console.error('[lobby] joinTable failed', err);
      this.error.set(err instanceof Error ? err.message : 'მაგიდასთან მიერთება ვერ მოხერხდა');
    } finally {
      this.busy.set(false);
      this.createInFlight = false;
    }
  }
}
