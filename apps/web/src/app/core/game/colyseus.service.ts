import { Injectable, inject, signal, computed } from '@angular/core';
import { Client, Room } from 'colyseus.js';
import {
  ClientIntent,
  ServerEvent,
  type ClientMessage,
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

  readonly connected = signal(false);
  readonly connecting = signal(false);
  readonly lastError = signal<string | null>(null);
  readonly view = signal<LiveRoomView | null>(null);

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

  async joinById(colyseusRoomId: string): Promise<void> {
    if (!colyseusRoomId) {
      throw new Error('Missing Colyseus room id from server');
    }
    console.info('[colyseus] joinById', colyseusRoomId, 'via', environment.gameServerWsUrl);
    await this.connect(async (token) =>
      this.client.joinById(colyseusRoomId, { accessToken: token }),
    );
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

  private async connect(factory: (token: string) => Promise<Room>): Promise<void> {
    const token = this.auth.accessToken();
    if (!token) throw new Error('Not authenticated');

    this.connecting.set(true);
    this.lastError.set(null);
    try {
      await this.leave();
      const room = await this.withTimeout(factory(token), 30_000, 'WebSocket join');
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
      this.connecting.set(false);
    }
  }

  private bindRoom(room: Room): void {
    room.onStateChange(() => this.syncFromState(room));
    room.onError((code, message) => {
      this.lastError.set(message ?? `Error ${code}`);
    });
    room.onLeave((code) => {
      this.connected.set(false);
      if (code !== 1000) {
        this.lastError.set('Disconnected from room');
      }
    });
    room.onMessage(ServerEvent.ACTION_REJECTED, (payload: { message?: string }) => {
      this.lastError.set(payload.message ?? 'Action rejected');
    });
    room.onMessage(ServerEvent.ERROR, (payload: { message?: string }) => {
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
    this.room.send('intent', message);
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

  async leave(): Promise<void> {
    if (this.room) {
      try {
        await this.room.leave(true);
      } catch {
        /* ignore */
      }
      this.room = null;
    }
    this.connected.set(false);
    this.view.set(null);
  }
}
