import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { GAME_CATALOG, GameType, normalizeInviteCode } from '@georgian-games/shared';
import { GameApiService } from '../../core/game/game-api.service';
import { ColyseusService } from '../../core/game/colyseus.service';

@Component({
  selector: 'app-lobby-page',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './lobby.page.html',
  styleUrl: './lobby.page.scss',
})
export class LobbyPage {
  private readonly api = inject(GameApiService);
  private readonly colyseus = inject(ColyseusService);
  private readonly router = inject(Router);

  readonly games = GAME_CATALOG;
  readonly GameType = GameType;

  joinCode = '';
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  readonly nardiMode = signal<'menu' | 'create-join'>('menu');

  selectNardi(): void {
    this.nardiMode.set('create-join');
    this.error.set(null);
  }

  backToGames(): void {
    this.nardiMode.set('menu');
  }

  async createTable(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const room = await this.api.createRoom(GameType.NARDI);
      await this.colyseus.joinById(room.colyseusRoomId);
      await this.router.navigate(['/room', room.inviteCode]);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not create table');
    } finally {
      this.busy.set(false);
    }
  }

  async joinTable(): Promise<void> {
    const code = normalizeInviteCode(this.joinCode);
    if (!code) {
      this.error.set('Enter an invite code');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const room = await this.api.joinByCode(code);
      await this.colyseus.joinById(room.colyseusRoomId);
      await this.router.navigate(['/room', room.inviteCode]);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not join table');
    } finally {
      this.busy.set(false);
    }
  }
}
