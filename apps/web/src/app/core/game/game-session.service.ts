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
    meta: Omit<ActiveGameSession, 'colyseusRoomId'>,
  ): Promise<void> {
    if (!reservation?.sessionId || !reservation?.room?.roomId) {
      throw new Error('Missing Colyseus seat reservation from server');
    }

    if (this.consumedSessionIds.has(reservation.sessionId)) {
      console.info(
        '[client:create] duplicate consume prevented session=',
        reservation.sessionId.slice(0, 8),
      );
      if (
        this.colyseus.connected() &&
        this.colyseus.currentRoomId() === reservation.room.roomId
      ) {
        this.meta.set({
          ...meta,
          colyseusRoomId: reservation.room.roomId,
        });
        return;
      }
      throw new Error('Seat reservation was already used. Create or join again.');
    }

    console.info(
      '[client:create] consuming reservation roomId=',
      reservation.room.roomId,
      'session=',
      reservation.sessionId.slice(0, 8),
    );

    this.consumedSessionIds.add(reservation.sessionId);
    try {
      await this.colyseus.consumeReservation(reservation);
    } catch (err) {
      this.consumedSessionIds.delete(reservation.sessionId);
      throw err;
    }

    this.meta.set({
      ...meta,
      colyseusRoomId: reservation.room.roomId,
    });

    console.info(
      '[client:create] reservation consumed roomId=',
      reservation.room.roomId,
      'socketOpen=',
      this.colyseus.socketOpen(),
    );
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
