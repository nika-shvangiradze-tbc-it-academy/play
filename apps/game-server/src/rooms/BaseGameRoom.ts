import { Room, type Client } from '@colyseus/core';
import {
  ClientIntent,
  ErrorCode,
  GameType,
  MatchStatus,
  RoomPhase,
  RoomStatus,
  ServerEvent,
  type ClientMessage,
} from '@georgian-games/shared';
import { authenticateToken, AuthError, type AuthProfile } from '../auth/verify-token.js';
import {
  createMatchRecord,
  completeMatchIdempotent,
  clearColyseusRoomIdIfMatch,
  ensureRoomMembership,
  markPlayerLeft,
  setPlayerReady,
  shortUserId,
  updateRoomStatus,
} from '../db/rooms.js';
import { getEnv, isDev } from '../config/env.js';
import { GameRoomState, SeatSchema } from './schema/GameRoomState.js';
import { processIdentity, shortId, traceLog } from '../http/lifecycle-trace.js';

export interface RoomMetadata {
  dbRoomId: string;
  inviteCode: string;
  gameType: GameType;
  hostUserId: string;
  maxPlayers: number;
  /** Correlates create→join→dispose logs across HTTP and Colyseus. */
  lifecycleTraceId: string;
}

interface PlayerSession {
  userId: string;
  username: string;
  seatNumber: number;
  reconnectTimeout?: ReturnType<typeof setTimeout>;
}

/**
 * Shared lobby / lifecycle room logic.
 * Game-specific rules live in subclasses (e.g. NardiRoom).
 */
export abstract class BaseGameRoom extends Room<GameRoomState> {
  roomMeta!: RoomMetadata;
  protected matchStarted = false;
  protected matchFinalized = false;
  protected sessions = new Map<string, PlayerSession>(); // sessionId → session
  protected userToSession = new Map<string, string>(); // userId → sessionId

  abstract getGameType(): GameType;

  override onCreate(options: RoomMetadata): void {
    this.roomMeta = options;
    this.setState(new GameRoomState());
    this.state.dbRoomId = options.dbRoomId;
    this.state.inviteCode = options.inviteCode;
    this.state.gameType = options.gameType;
    this.state.hostUserId = options.hostUserId;
    this.state.maxPlayers = options.maxPlayers;
    this.state.lifecycleTraceId = options.lifecycleTraceId || '';
    this.state.phase = RoomPhase.WAITING;
    // Exactly catalog max (Nardi = 2). Empty createRoom alone does NOT hold a seat.
    this.maxClients = options.maxPlayers;
    this.autoDispose = true;

    // Private: not joinable via public joinOrCreate — only via invite + reserved seat.
    void this.setPrivate(true);

    /**
     * Seat reservation TTL (seconds). Constructor already scheduled autoDispose with the
     * default; setSeatReservationTime alone does not reschedule. Creating via
     * reserveSeatFor() holds reservedSeats so the room cannot dispose until the
     * reservation expires or is consumed.
     */
    this.setSeatReservationTime(45);

    this.onMessage('intent', (client, message: ClientMessage) => {
      void this.handleIntent(client, message);
    });

    const tid = options.lifecycleTraceId || 'none';
    traceLog(tid, `onCreate roomId=${this.roomId}`);
  }

  override async onDispose(): Promise<void> {
    const tid = this.state.lifecycleTraceId || this.roomMeta?.lifecycleTraceId || 'none';
    const reserved = Object.keys(this.reservedSeats ?? {}).length;
    const { pid, processId } = processIdentity();
    traceLog(
      tid,
      `onDispose roomId=${this.roomId} clients=${this.clients.length} reservedSeats=${reserved} phase=${this.state.phase} processId=${processId} pid=${pid}`,
    );
    if (this.state.dbRoomId) {
      try {
        traceLog(tid, `DB clearing colyseus_room_id because=onDispose roomId=${this.roomId}`);
        await clearColyseusRoomIdIfMatch(this.state.dbRoomId, this.roomId);
      } catch (err) {
        console.error('[nardi:onDispose] failed to clear colyseus_room_id', err);
      }
    }
  }

  override async onAuth(client: Client, options: { accessToken?: string }): Promise<AuthProfile> {
    const tid = this.state.lifecycleTraceId || this.roomMeta?.lifecycleTraceId || 'none';
    try {
      const hasToken = typeof options?.accessToken === 'string' && options.accessToken.length > 0;
      traceLog(
        tid,
        `onAuth begin session=${shortId(client.sessionId)} hasToken=${hasToken}`,
      );
      if (!hasToken) {
        throw new AuthError(ErrorCode.UNAUTHENTICATED, 'Missing access token');
      }
      const profile = await authenticateToken(options.accessToken!);

      // Reject if another live session for same user (unless reconnecting)
      const existingSessionId = this.userToSession.get(profile.userId);
      if (existingSessionId) {
        const existing = this.clients.find((c) => c.sessionId === existingSessionId);
        if (existing && existing.sessionId !== client.sessionId) {
          // Allow replace only if marked reconnecting / disconnected
          const seat = this.findSeatByUser(profile.userId);
          if (seat && !seat.reconnecting && seat.connected) {
            throw new AuthError(ErrorCode.DUPLICATE_CONNECTION, 'Already connected from another session');
          }
        }
      }

      traceLog(tid, `onAuth success user=${shortUserId(profile.userId)}`);
      return profile;
    } catch (err) {
      if (err instanceof AuthError) {
        traceLog(tid, `onAuth rejected code=${err.code} message=${err.message}`);
        throw err;
      }
      console.error('[auth] unexpected', err);
      throw new AuthError(ErrorCode.SERVER_ERROR, 'Authentication failed');
    }
  }

  override async onJoin(client: Client, _options: unknown, auth?: AuthProfile): Promise<void> {
    if (!auth) {
      throw new AuthError(ErrorCode.UNAUTHENTICATED, 'Missing auth context');
    }
    const existingSeat = this.findSeatByUser(auth.userId);

    if (existingSeat) {
      // Reconnect — same user, same seat (never a second Colyseus slot).
      this.clearReconnectTimer(auth.userId);
      existingSeat.connected = true;
      existingSeat.reconnecting = false;

      const prevSessionId = this.userToSession.get(auth.userId);
      if (prevSessionId) {
        this.sessions.delete(prevSessionId);
      }

      this.sessions.set(client.sessionId, {
        userId: auth.userId,
        username: auth.username,
        seatNumber: existingSeat.seatNumber,
      });
      this.userToSession.set(auth.userId, client.sessionId);

      await ensureRoomMembership(this.state.dbRoomId, auth.userId, existingSeat.seatNumber);

      this.broadcast(ServerEvent.PLAYER_RECONNECTED, {
        type: ServerEvent.PLAYER_RECONNECTED,
        userId: auth.userId,
        seatNumber: existingSeat.seatNumber,
      });

      console.log(
        `[nardi:onJoin] roomId=${this.roomId} user=${shortUserId(auth.userId)} clients=${this.clients.length}/${this.maxClients} reconnect=true`,
      );
      traceLog(
        this.state.lifecycleTraceId || 'none',
        `onJoin user=${shortUserId(auth.userId)} clients=${this.clients.length}/${this.maxClients} reconnect=true`,
      );
      return;
    }

    if (this.matchStarted || this.state.phase === RoomPhase.PLAYING || this.state.phase === RoomPhase.FINISHED) {
      throw new AuthError(ErrorCode.GAME_ALREADY_STARTED, 'Game already started');
    }

    // Distinct users in schema seats — same account cannot take two seats.
    if (this.state.seats.size >= this.state.maxPlayers) {
      throw new AuthError(ErrorCode.ROOM_FULL, 'Room is full');
    }

    const seatNumber = this.nextSeatNumber();
    const seat = new SeatSchema();
    seat.userId = auth.userId;
    seat.username = auth.username;
    seat.seatNumber = seatNumber;
    seat.isReady = false;
    seat.connected = true;
    seat.reconnecting = false;
    this.state.seats.set(String(seatNumber), seat);

    this.sessions.set(client.sessionId, {
      userId: auth.userId,
      username: auth.username,
      seatNumber,
    });
    this.userToSession.set(auth.userId, client.sessionId);

    // Authoritative membership for guests (host already inserted on HTTP create — idempotent).
    await ensureRoomMembership(this.state.dbRoomId, auth.userId, seatNumber);

    console.log(
      `[nardi:onJoin] roomId=${this.roomId} user=${shortUserId(auth.userId)} clients=${this.clients.length}/${this.maxClients} reconnect=false`,
    );
    traceLog(
      this.state.lifecycleTraceId || 'none',
      `onJoin user=${shortUserId(auth.userId)} clients=${this.clients.length}/${this.maxClients} reconnect=false`,
    );
  }

  override async onLeave(client: Client, consented: boolean): Promise<void> {
    const tid = this.state.lifecycleTraceId || this.roomMeta?.lifecycleTraceId || 'none';
    const session = this.sessions.get(client.sessionId);
    if (!session) {
      traceLog(tid, `onLeave entered session=? consented=${consented} (no session map entry)`);
      return;
    }

    const seat = this.state.seats.get(String(session.seatNumber));
    if (!seat) {
      traceLog(
        tid,
        `onLeave entered user=${shortUserId(session.userId)} consented=${consented} (no seat)`,
      );
      return;
    }

    traceLog(
      tid,
      `onLeave entered user=${shortUserId(session.userId)} consented=${consented} clientsBeforeDecrement=${this.clients.length}`,
    );

    /**
     * Waiting lobby:
     * - Consented leave: free the seat immediately (empty room auto-disposes).
     * - Accidental disconnect: await allowReconnection so onLeave does not return
     *   (and _decrementClientCount does not run) until reconnect or grace timeout.
     */
    if (!this.matchStarted && this.state.phase === RoomPhase.WAITING) {
      if (consented) {
        this.state.seats.delete(String(session.seatNumber));
        this.sessions.delete(client.sessionId);
        this.userToSession.delete(session.userId);
        await markPlayerLeft(this.state.dbRoomId, session.userId);
        traceLog(tid, `onLeave returning (WAITING consented — seat freed)`);
        return;
      }

      const waitingGraceMs = Math.min(15_000, getEnv().RECONNECT_GRACE_MS);
      seat.connected = false;
      seat.reconnecting = true;
      this.broadcast(ServerEvent.PLAYER_DISCONNECTED, {
        type: ServerEvent.PLAYER_DISCONNECTED,
        userId: session.userId,
        seatNumber: session.seatNumber,
        graceMsRemaining: waitingGraceMs,
      });

      const graceSec = waitingGraceMs / 1000;
      traceLog(tid, `allowReconnection begin seconds=${graceSec}`);
      try {
        // Must await — Colyseus 0.15 holds disposal until this promise settles.
        await this.allowReconnection(client, graceSec);
        seat.connected = true;
        seat.reconnecting = false;
        traceLog(tid, `allowReconnection resolved (reconnect success)`);
      } catch {
        seat.reconnecting = false;
        this.state.seats.delete(String(session.seatNumber));
        this.sessions.delete(client.sessionId);
        this.userToSession.delete(session.userId);
        await markPlayerLeft(this.state.dbRoomId, session.userId);
        traceLog(tid, `allowReconnection rejected (timeout/fail) — seat freed`);
      }
      traceLog(tid, `onLeave returning (WAITING unconsented path complete)`);
      return;
    }

    // In-match disconnect — grace period reconnection
    const grace = getEnv().RECONNECT_GRACE_MS;
    seat.connected = false;
    seat.reconnecting = true;

    this.broadcast(ServerEvent.PLAYER_DISCONNECTED, {
      type: ServerEvent.PLAYER_DISCONNECTED,
      userId: session.userId,
      seatNumber: session.seatNumber,
      graceMsRemaining: grace,
    });

    const graceSec = grace / 1000;
    traceLog(tid, `allowReconnection begin (in-match) seconds=${graceSec}`);
    try {
      await this.allowReconnection(client, graceSec);
      seat.connected = true;
      seat.reconnecting = false;
      traceLog(tid, `allowReconnection resolved (in-match reconnect success)`);
    } catch {
      seat.reconnecting = false;
      await this.handleAbandonment(session.userId, session.seatNumber);
      traceLog(tid, `allowReconnection rejected (in-match) — abandonment`);
    }
    traceLog(tid, `onLeave returning (in-match path complete)`);
  }

  protected async handleAbandonment(userId: string, seatNumber: number): Promise<void> {
    if (this.matchFinalized) return;

    if (!this.matchStarted) {
      this.state.seats.delete(String(seatNumber));
      this.userToSession.delete(userId);
      await markPlayerLeft(this.state.dbRoomId, userId);
      return;
    }

    // Opponent wins by abandonment
    const winner = [...this.state.seats.values()].find((s) => s.userId !== userId);
    await this.finalizeMatch(winner?.userId ?? null, MatchStatus.ABANDONED, `Player abandoned: ${userId}`);
  }

  protected async handleIntent(client: Client, message: ClientMessage): Promise<void> {
    const session = this.sessions.get(client.sessionId);
    if (!session) {
      this.sendError(client, ErrorCode.NOT_IN_ROOM, 'Not in room');
      return;
    }

    try {
      switch (message.type) {
        case ClientIntent.READY:
          await this.onReady(client, session, true);
          break;
        case ClientIntent.UNREADY:
          await this.onReady(client, session, false);
          break;
        case ClientIntent.LEAVE_ROOM:
          client.leave(1000);
          break;
        default:
          await this.onGameIntent(client, session, message);
      }
    } catch (err) {
      console.error('[intent] error', err);
      this.sendError(client, ErrorCode.SERVER_ERROR, 'Action failed');
    }
  }

  protected async onReady(
    client: Client,
    session: PlayerSession,
    ready: boolean,
  ): Promise<void> {
    if (this.matchStarted) {
      this.sendError(client, ErrorCode.GAME_ALREADY_STARTED, 'Match already started');
      return;
    }

    const seat = this.state.seats.get(String(session.seatNumber));
    if (!seat) return;

    seat.isReady = ready;
    await setPlayerReady(this.state.dbRoomId, session.userId, ready);

    await this.tryStartMatch();
  }

  /**
   * Idempotent match start when all seats filled and ready.
   */
  protected async tryStartMatch(): Promise<void> {
    if (this.matchStarted) return;
    if (this.state.seats.size < this.state.maxPlayers) return;

    const allReady = [...this.state.seats.values()].every((s) => s.isReady && s.connected);
    if (!allReady) return;

    this.matchStarted = true;
    this.state.phase = RoomPhase.STARTING;

    try {
      await updateRoomStatus(this.state.dbRoomId, RoomStatus.STARTING);

      const players = [...this.state.seats.values()].map((s) => ({
        userId: s.userId,
        seatNumber: s.seatNumber,
      }));

      const matchId = await createMatchRecord(this.state.dbRoomId, this.getGameType(), players);
      this.state.matchId = matchId;

      await updateRoomStatus(this.state.dbRoomId, RoomStatus.PLAYING, {
        started_at: new Date().toISOString(),
      });

      this.state.phase = RoomPhase.PLAYING;
      this.onMatchStart();

      this.broadcast(ServerEvent.MATCH_STARTED, {
        type: ServerEvent.MATCH_STARTED,
        matchId,
      });

      if (isDev()) console.log(`[room] match started ${matchId}`);
    } catch (err) {
      console.error('[room] start failed', err);
      this.matchStarted = false;
      this.state.phase = RoomPhase.WAITING;
      this.broadcast(ServerEvent.ERROR, {
        type: ServerEvent.ERROR,
        code: ErrorCode.SERVER_ERROR,
        message: 'Failed to start match',
      });
    }
  }

  protected async finalizeMatch(
    winnerUserId: string | null,
    status: MatchStatus = MatchStatus.COMPLETED,
    abandonmentReason: string | null = null,
  ): Promise<void> {
    if (this.matchFinalized) return;
    this.matchFinalized = true;
    this.state.phase = RoomPhase.FINISHED;

    if (winnerUserId) {
      const seat = [...this.state.seats.values()].find((s) => s.userId === winnerUserId);
      this.state.winnerSeat = seat?.seatNumber ?? -1;
    }

    try {
      if (this.state.matchId) {
        await completeMatchIdempotent(
          this.state.matchId,
          winnerUserId,
          status,
          abandonmentReason,
        );
      }
      this.broadcast(ServerEvent.MATCH_FINISHED, {
        type: ServerEvent.MATCH_FINISHED,
        matchId: this.state.matchId,
        winnerUserId,
        reason: status === MatchStatus.ABANDONED ? 'abandonment' : 'normal',
      });
    } catch (err) {
      console.error('[room] finalize failed', err);
    }

    // Dispose shortly after finish
    this.clock.setTimeout(() => {
      void this.disconnect();
    }, 30_000);
  }

  protected sendError(client: Client, code: ErrorCode, message: string): void {
    client.send(ServerEvent.ACTION_REJECTED, {
      type: ServerEvent.ACTION_REJECTED,
      code,
      message,
    });
  }

  protected findSeatByUser(userId: string): SeatSchema | undefined {
    return [...this.state.seats.values()].find((s) => s.userId === userId);
  }

  protected nextSeatNumber(): number {
    for (let i = 0; i < this.state.maxPlayers; i++) {
      if (!this.state.seats.has(String(i))) return i;
    }
    throw new AuthError(ErrorCode.ROOM_FULL, 'No seats available');
  }

  protected clearReconnectTimer(userId: string): void {
    const sessionId = this.userToSession.get(userId);
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (session?.reconnectTimeout) {
      clearTimeout(session.reconnectTimeout);
      session.reconnectTimeout = undefined;
    }
  }

  /** Subclasses implement game-specific intents and start hook. */
  protected abstract onGameIntent(
    client: Client,
    session: PlayerSession,
    message: ClientMessage,
  ): Promise<void>;

  protected abstract onMatchStart(): void;
}

export type { PlayerSession };
