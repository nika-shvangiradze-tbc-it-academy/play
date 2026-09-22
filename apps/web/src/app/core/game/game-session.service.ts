import { Injectable, computed, inject, signal } from '@angular/core';
import type { ColyseusSeatReservation, GameType } from '@georgian-games/shared';
import { ColyseusService } from './colyseus.service';

export interface ActiveGameSession {
  dbRoomId: string;
  inviteCode: string;
  gameType: GameType | string;
  colyseusRoomId: string;
  role: 'host' | 'guest';
}

/**
 * Persistent owner of the live matchmaking session.
 * Survives LobbyPage / RoomPage destroy; only leaves on explicit user action,
 * logout, match end, or unrecoverable socket loss handled by ColyseusService.
 */
@Injectable({ providedIn: 'root' })
export class GameSessionService {
  private readonly colyseus = inject(ColyseusService);
  private readonly meta = signal<ActiveGameSession | null>(null);
  private consumedSessionIds = new Set<string>();

  readonly connected = this.colyseus.connected;
  readonly connecting = this.colyseus.connecting;
  readonly lastError = this.colyseus.lastError;
  readonly view = this.colyseus.view;
  readonly mySeat = this.colyseus.mySeat;
  readonly isMyTurn = this.colyseus.isMyTurn;
  readonly socketOpen = this.colyseus.socketOpen;

  readonly session = computed(() => this.meta());

  /**
   * Consume a server seat reservation exactly once and retain the live Room
   * on the root ColyseusService (not on a page/component).
   */
  async enterWithReservation(
    reservation: ColyseusSeatReservation,
    meta: Omit<ActiveGameSession, 'colyseusRoomId'> & { lifecycleTraceId?: string },
  ): Promise<void> {
    if (!reservation?.sessionId || !reservation?.room?.roomId) {
      throw new Error('სერვერიდან ადგილის რეზერვაცია აკლია');
    }

    const trace = meta.lifecycleTraceId ?? 'none';

    if (this.consumedSessionIds.has(reservation.sessionId)) {
      console.info(
        `[trace:${trace}] CLIENT duplicate consume prevented session=`,
        reservation.sessionId.slice(0, 8),
      );
      if (
        this.colyseus.connected() &&
        this.colyseus.currentRoomId() === reservation.room.roomId
      ) {
        this.meta.set({
          dbRoomId: meta.dbRoomId,
          inviteCode: meta.inviteCode,
          gameType: meta.gameType,
          role: meta.role,
          colyseusRoomId: reservation.room.roomId,
        });
        return;
      }
      throw new Error('ადგილი უკვე გამოყენებულია. შექმენი ან შეუერთდი ხელახლა.');
    }

    this.consumedSessionIds.add(reservation.sessionId);
    try {
      await this.colyseus.consumeReservation(reservation, {
        lifecycleTraceId: meta.lifecycleTraceId,
      });
    } catch (err) {
      this.consumedSessionIds.delete(reservation.sessionId);
      throw err;
    }

    if (!this.colyseus.socketOpen()) {
      throw new Error('შემქმნელის კავშირი არ არის ღია — ცოცხალი მოწვევა ვერ გამოჩნდება');
    }

    this.meta.set({
      dbRoomId: meta.dbRoomId,
      inviteCode: meta.inviteCode,
      gameType: meta.gameType,
      role: meta.role,
      colyseusRoomId: reservation.room.roomId,
    });
  }

  ready(): void {
    this.colyseus.ready();
  }

  unready(): void {
    this.colyseus.unready();
  }

  rollDice(): void {
    this.colyseus.rollDice();
  }

  moveChecker(from: number, to: number): void {
    this.colyseus.moveChecker(from, to);
  }

  /** Explicit leave (button / logout). Clears session metadata. */
  async leave(): Promise<void> {
    this.meta.set(null);
    await this.colyseus.leave();
  }

  clearMetadata(): void {
    this.meta.set(null);
  }
}
