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
  /** Prevents overlapping join / leave races that close an in-flight socket. */
  private joinEpoch = 0;
  private joinInFlight: Promise<void> | null = null;

  readonly connected = signal(false);
  readonly connecting = signal(false);
  readonly lastError = signal<string | null>(null);
  readonly view = signal<LiveRoomView | null>(null);
  /** Test/diagnostic: how many consume attempts were started. */
  readonly joinAttempts = signal(0);
  /** True while the underlying WebSocket reports OPEN. */
  readonly socketOpen = signal(false);

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

  currentRoomId(): string | null {
    return this.room?.roomId ?? null;
  }

  /**
   * Consume a server-issued Colyseus 0.15 seat reservation exactly once.
   * Do not call joinById with only a room id — empty rooms auto-dispose without a reservation.
   * Resolves only after Room exists, socket is OPEN, and synced state includes our seat (onJoin).
   */
  async consumeReservation(
    reservation: ColyseusSeatReservation,
    opts?: { lifecycleTraceId?: string },
  ): Promise<void> {
    if (!reservation?.sessionId || !reservation?.room?.roomId) {
      throw new Error('Missing Colyseus seat reservation from server');
    }

    const trace = opts?.lifecycleTraceId ?? 'none';
    const colyseusRoomId = reservation.room.roomId;
    const expectedWs = this.buildSanitizedWsEndpoint(reservation);

    console.info(`[trace:${trace}] CLIENT reservation received roomId=${colyseusRoomId}`);
    console.info(
      `[trace:${trace}] CLIENT expected WS endpoint=${expectedWs} (clientBase=${environment.gameServerWsUrl})`,
    );

    if (this.room && this.room.roomId === colyseusRoomId && this.isRoomSocketOpen(this.room)) {
      console.info(`[trace:${trace}] CLIENT consume skipped — already connected`);
      this.connected.set(true);
      this.socketOpen.set(true);
      return;
    }

    if (this.joinInFlight) {
      console.info(`[trace:${trace}] CLIENT waiting for in-flight join`);
      await this.withTimeout(this.joinInFlight, 30_000, 'In-flight WebSocket join');
      if (this.room && this.room.roomId === colyseusRoomId && this.isRoomSocketOpen(this.room)) {
        this.connected.set(true);
        this.socketOpen.set(true);
        return;
      }
    }

    console.info(`[trace:${trace}] CLIENT consumeSeatReservation begin`);
    this.joinAttempts.update((n) => n + 1);

    const run = this.connect(async () => this.client.consumeSeatReservation(reservation), trace);
    this.joinInFlight = run.finally(() => {
      this.joinInFlight = null;
    });
    await this.joinInFlight;

    await this.assertLiveCreatorConnection(trace);
  }

  /** Reconstruct the same URL shape Colyseus 0.15.57 Client.buildEndpoint uses (no secrets). */
  private buildSanitizedWsEndpoint(reservation: ColyseusSeatReservation): string {
    const room = reservation.room;
    const base = environment.gameServerWsUrl;
    const secure = base.startsWith('wss');
    const proto = secure ? 'wss://' : 'ws://';
    let hostPart: string;
    if (room.publicAddress) {
      hostPart = room.publicAddress;
    } else {
      try {
        const u = new URL(base.replace(/^ws/, 'http'));
        hostPart = u.host + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, ''));
      } catch {
        hostPart = base.replace(/^wss?:\/\//, '');
      }
    }
    return `${proto}${hostPart}/${room.processId}/${room.roomId}?sessionId=${reservation.sessionId.slice(0, 8)}…`;
  }

  private async assertLiveCreatorConnection(trace: string): Promise<void> {
    const room = this.room;
    if (!room) {
      throw new Error('Seat reservation consumed but no Room object was retained');
    }
    if (!room.connection) {
      throw new Error('Room exists but connection object is missing');
    }
    if (!this.isRoomSocketOpen(room)) {
      throw new Error('WebSocket is not OPEN after consumeSeatReservation');
    }

    const uid = this.auth.user()?.id;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      this.syncFromState(room);
      this.socketOpen.set(this.isRoomSocketOpen(room));
      const seats = this.view()?.seats ?? [];
      const hasSeat = uid ? seats.some((s) => s.userId === uid && s.connected) : seats.length > 0;
      if (hasSeat && this.isRoomSocketOpen(room)) {
        console.info(
          `[trace:${trace}] CLIENT consume success socketOpen=true seats=${seats.length} roomId=${room.roomId}`,
        );
        this.connected.set(true);
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    throw new Error(
      'Connected to Colyseus but server onJoin/seat sync did not arrive — table is not live',
    );
  }

  private isRoomSocketOpen(room: Room): boolean {
    const conn = (room as Room & { connection?: { isOpen?: boolean; readyState?: number } })
      .connection;
    if (!conn) return false;
    if (typeof conn.isOpen === 'boolean') return conn.isOpen;
    // Fallback for raw WebSocket-shaped transports
    return conn.readyState === 1;
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

  private async connect(factory: () => Promise<Room>, trace = 'none'): Promise<void> {
    if (!this.auth.accessToken()) throw new Error('Not authenticated');

    const epoch = ++this.joinEpoch;
    this.connecting.set(true);
    this.lastError.set(null);
    let joined: Room | null = null;
    try {
      // Only detach a *different* live room. Never leave(false) a socket we are
      // about to keep — WAITING rooms autoDispose on empty.
      if (this.room) {
        console.info(`[trace:${trace}] CLIENT replacing existing room via detachCurrentRoom`);
        await this.detachCurrentRoom(/* consented */ false);
      }
      if (epoch !== this.joinEpoch) {
        throw new Error('Join superseded');
      }
      joined = await this.withTimeout(factory(), 30_000, 'WebSocket join');
      console.info(`[trace:${trace}] CLIENT WS open roomId=${joined.roomId}`);
      if (epoch !== this.joinEpoch) {
        try {
          await joined.leave(false);
        } catch {
          /* ignore */
        }
        joined = null;
        throw new Error('Join superseded');
      }
      this.room = joined;
      this.connected.set(true);
      this.socketOpen.set(this.isRoomSocketOpen(joined));
      this.bindRoom(joined);
      this.syncFromState(joined);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      console.error(`[trace:${trace}] CLIENT connect failed`, err);
      this.lastError.set(message);
      this.connected.set(false);
      this.socketOpen.set(false);
      if (joined && this.room === joined) {
        this.room = null;
        try {
          await joined.leave(false);
        } catch {
          /* ignore */
        }
      } else if (joined) {
        try {
          await joined.leave(false);
        } catch {
          /* ignore */
        }
      }
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
      this.socketOpen.set(this.isRoomSocketOpen(room));
    });
    room.onError((code, message) => {
      if (this.room !== room) return;
      this.lastError.set(message ?? `Error ${code}`);
    });
    room.onLeave((code) => {
      if (this.room !== room) return;
      console.warn(
        '[colyseus] room onLeave code=',
        code,
        'roomId=',
        room.roomId,
        '— connection dropped; WAITING rooms dispose when empty',
      );
      this.connected.set(false);
      this.socketOpen.set(false);
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

    const legalRaw = s['legalMoves'] as
      | {
          length: number;
          [i: number]: Record<string, unknown> & { from?: number; to?: number; die?: number; hit?: boolean };
          forEach?: (cb: (v: Record<string, unknown>) => void) => void;
        }
      | undefined;
    const legalMoves: LiveLegalMove[] = [];
    const pushLegal = (m: Record<string, unknown> & { from?: number; to?: number; die?: number; hit?: boolean }) => {
      legalMoves.push({
        from: Number(m.from ?? m['from'] ?? 0),
        to: Number(m.to ?? m['to'] ?? 0),
        die: Number(m.die ?? m['die'] ?? 0),
        hit: Boolean(m.hit ?? m['hit']),
      });
    };
    if (legalRaw) {
      if (typeof legalRaw.forEach === 'function') {
        legalRaw.forEach((m) => pushLegal(m as typeof m & { from?: number }));
      } else {
        for (let i = 0; i < legalRaw.length; i++) {
          pushLegal(legalRaw[i]!);
        }
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
    const msg: MoveCheckerMessage = {
      type: ClientIntent.MOVE_CHECKER,
      from: Number(from),
      to: Number(to),
    };
    this.sendIntent(msg);
  }

  /** Server-authoritative pass when no legal moves remain (recovery path). */
  pass(): void {
    this.sendIntent({ type: ClientIntent.PASS });
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
    this.socketOpen.set(false);
    if (!room) {
      this.view.set(null);
      return;
    }
    console.info(
      '[colyseus] detachCurrentRoom consented=',
      consented,
      'roomId=',
      room.roomId,
    );
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
