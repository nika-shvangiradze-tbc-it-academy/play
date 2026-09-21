import { Injectable, inject, signal, computed } from '@angular/core';
import { Client, Room } from 'colyseus.js';
import {
  ClientIntent,
  ServerEvent,
  type ClientMessage,
  type ColyseusSeatReservation,
  type MoveCheckerMessage,
} from '@georgian-games/shared';
import { environment } from '../../../environments/environment';
import { AuthService } from '../auth/auth.service';

/** Client-side mirror of authoritative room state (from Colyseus schema). */
export interface LiveSeat {
  userId: string;
  username: string;
  seatNumber: number;
  isReady: boolean;
  connected: boolean;
  reconnecting: boolean;
}

export interface LiveLegalMove {
  from: number;
  to: number;
  die: number;
  hit: boolean;
}

export interface LiveRoomView {
  dbRoomId: string;
  inviteCode: string;
  gameType: string;
  phase: string;
  hostUserId: string;
  maxPlayers: number;
  matchId: string;
  nardiPhase: string;
  currentTurn: number;
  turnNumber: number;
  winnerSeat: number;
  dice: { d1: number; d2: number; rolled: boolean; remaining: number[] };
  points: number[];
  bar0: number;
  bar1: number;
  off0: number;
  off1: number;
  seats: LiveSeat[];
  legalMoves: LiveLegalMove[];
}

@Injectable({ providedIn: 'root' })
export class ColyseusService {
  private readonly auth = inject(AuthService);
  private client = new Client(environment.gameServerWsUrl);
  private room: Room | null = null;
  /** Prevents overlapping joinById / leave races that close an in-flight socket. */
  private joinEpoch = 0;
  private joinInFlight: Promise<void> | null = null;

  readonly connected = signal(false);
  readonly connecting = signal(false);
  readonly lastError = signal<string | null>(null);
  readonly view = signal<LiveRoomView | null>(null);
  /** Test/diagnostic: how many joinById attempts were started. */
  readonly joinAttempts = signal(0);

  readonly mySeat = computed(() => {
    const uid = this.auth.user()?.id;
    const v = this.view();
    if (!uid || !v) return null;
    return v.seats.find((s) => s.userId === uid) ?? null;
  });

  readonly isMyTurn = computed(() => {
    const seat = this.mySeat();
    const v = this.view();
    if (!seat || !v) return false;
    return v.phase === 'PLAYING' && v.currentTurn === seat.seatNumber;
  });

  /**
   * Consume a server-issued Colyseus 0.15 seat reservation exactly once.
   * Do not call joinById with only a room id — empty rooms auto-dispose without a reservation.
   */
  async consumeReservation(reservation: ColyseusSeatReservation): Promise<void> {
    if (!reservation?.sessionId || !reservation?.room?.roomId) {
      throw new Error('Missing Colyseus seat reservation from server');
    }

    const colyseusRoomId = reservation.room.roomId;

    if (this.room && this.room.roomId === colyseusRoomId && this.connected()) {
      console.info('[colyseus] consumeReservation skipped — already connected', colyseusRoomId);
      return;
    }

    if (this.joinInFlight) {
      console.info('[colyseus] consumeReservation waiting for in-flight join');
      await this.joinInFlight;
      if (this.room && this.room.roomId === colyseusRoomId && this.connected()) {
        return;
      }
    }

    console.info(
      '[client:create] attempting joinById/consumeSeatReservation',
      colyseusRoomId,
      'session',
      reservation.sessionId,
      'via',
      environment.gameServerWsUrl,
    );
    this.joinAttempts.update((n) => n + 1);

    const run = this.connect(async () =>
      this.client.consumeSeatReservation(reservation),
    );
    this.joinInFlight = run.finally(() => {
      this.joinInFlight = null;
    });
    await this.joinInFlight;
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `${label} timed out after ${Math.round(ms / 1000)}s. The game server may be waking up — try again.`,
              ),
            );
          }, ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async connect(factory: () => Promise<Room>): Promise<void> {
    if (!this.auth.accessToken()) throw new Error('Not authenticated');

    const epoch = ++this.joinEpoch;
    this.connecting.set(true);
    this.lastError.set(null);
    try {
      await this.detachCurrentRoom(/* consented */ false);
      if (epoch !== this.joinEpoch) {
        throw new Error('Join superseded');
      }
      const room = await this.withTimeout(factory(), 30_000, 'WebSocket join');
      if (epoch !== this.joinEpoch) {
        try {
          await room.leave(false);
        } catch {
          /* ignore */
        }
        throw new Error('Join superseded');
      }
      this.room = room;
      this.connected.set(true);
      this.bindRoom(room);
      this.syncFromState(room);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      console.error('[colyseus] connect failed', err);
      this.lastError.set(message);
      this.connected.set(false);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      if (epoch === this.joinEpoch) {
        this.connecting.set(false);
      }
    }
  }

  private bindRoom(room: Room): void {
    room.onStateChange(() => {
      if (this.room !== room) return;
      this.syncFromState(room);
    });
    room.onError((code, message) => {
      if (this.room !== room) return;
      this.lastError.set(message ?? `Error ${code}`);
    });
    room.onLeave((code) => {
      if (this.room !== room) return;
      this.connected.set(false);
      this.room = null;
      if (code !== 1000) {
        this.lastError.set('Disconnected from room');
      }
    });
    room.onMessage(ServerEvent.ACTION_REJECTED, (payload: { message?: string }) => {
      if (this.room !== room) return;
      this.lastError.set(payload.message ?? 'Action rejected');
    });
    room.onMessage(ServerEvent.ERROR, (payload: { message?: string }) => {
      if (this.room !== room) return;
      this.lastError.set(payload.message ?? 'Server error');
    });
  }

  private syncFromState(room: Room): void {
    const s = room.state as Record<string, unknown>;
    const seatsMap = s['seats'] as { forEach: (cb: (v: Record<string, unknown>) => void) => void };
    const seats: LiveSeat[] = [];
    seatsMap?.forEach((v) => {
      seats.push({
        userId: String(v['userId'] ?? ''),
        username: String(v['username'] ?? ''),
        seatNumber: Number(v['seatNumber'] ?? 0),
        isReady: Boolean(v['isReady']),
        connected: Boolean(v['connected']),
        reconnecting: Boolean(v['reconnecting']),
      });
    });
    seats.sort((a, b) => a.seatNumber - b.seatNumber);

    const pointsArr = s['points'] as { length: number; [i: number]: number } | undefined;
    const points: number[] = [];
    if (pointsArr) {
      for (let i = 0; i < pointsArr.length; i++) {
        points.push(Number(pointsArr[i] ?? 0));
      }
    }

    const dice = s['dice'] as Record<string, unknown> | undefined;
    const remainingRaw = dice?.['remaining'] as { length: number; [i: number]: number } | undefined;
    const remaining: number[] = [];
    if (remainingRaw) {
      for (let i = 0; i < remainingRaw.length; i++) {
        remaining.push(Number(remainingRaw[i] ?? 0));
      }
    }

    const legalRaw = s['legalMoves'] as {
      length: number;
      [i: number]: Record<string, unknown>;
    } | undefined;
    const legalMoves: LiveLegalMove[] = [];
    if (legalRaw) {
      for (let i = 0; i < legalRaw.length; i++) {
        const m = legalRaw[i]!;
        legalMoves.push({
          from: Number(m['from'] ?? 0),
          to: Number(m['to'] ?? 0),
          die: Number(m['die'] ?? 0),
          hit: Boolean(m['hit']),
        });
      }
    }

    this.view.set({
      dbRoomId: String(s['dbRoomId'] ?? ''),
      inviteCode: String(s['inviteCode'] ?? ''),
      gameType: String(s['gameType'] ?? ''),
      phase: String(s['phase'] ?? ''),
      hostUserId: String(s['hostUserId'] ?? ''),
      maxPlayers: Number(s['maxPlayers'] ?? 2),
      matchId: String(s['matchId'] ?? ''),
      nardiPhase: String(s['nardiPhase'] ?? ''),
      currentTurn: Number(s['currentTurn'] ?? 0),
      turnNumber: Number(s['turnNumber'] ?? 1),
      winnerSeat: Number(s['winnerSeat'] ?? -1),
      dice: {
        d1: Number(dice?.['d1'] ?? 0),
        d2: Number(dice?.['d2'] ?? 0),
        rolled: Boolean(dice?.['rolled']),
        remaining,
      },
      points,
      bar0: Number(s['bar0'] ?? 0),
      bar1: Number(s['bar1'] ?? 0),
      off0: Number(s['off0'] ?? 0),
      off1: Number(s['off1'] ?? 0),
      seats,
      legalMoves,
    });
  }

  sendIntent(message: ClientMessage): void {
    if (!this.room) return;
    this.lastError.set(null);
    try {
      this.room.send('intent', message);
    } catch (err) {
      console.warn('[colyseus] send failed (socket closing?)', err);
    }
  }

  ready(): void {
    this.sendIntent({ type: ClientIntent.READY });
  }

  unready(): void {
    this.sendIntent({ type: ClientIntent.UNREADY });
  }

  rollDice(): void {
    this.sendIntent({ type: ClientIntent.ROLL_DICE });
  }

  moveChecker(from: number, to: number): void {
    const msg: MoveCheckerMessage = { type: ClientIntent.MOVE_CHECKER, from, to };
    this.sendIntent(msg);
  }

  leaveRoom(): void {
    this.sendIntent({ type: ClientIntent.LEAVE_ROOM });
  }

  /**
   * Drop the current room without racing a new join.
   * Use consented=true only for explicit user Leave (drops DB membership on server).
   */
  private async detachCurrentRoom(consented: boolean): Promise<void> {
    const room = this.room;
    this.room = null;
    this.connected.set(false);
    if (!room) {
      this.view.set(null);
      return;
    }
    try {
      await room.leave(consented);
    } catch {
      /* already CLOSING/CLOSED — ignore */
    }
    this.view.set(null);
  }

  async leave(): Promise<void> {
    this.joinEpoch += 1;
    await this.detachCurrentRoom(true);
  }
}
