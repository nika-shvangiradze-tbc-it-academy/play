import {
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { fromEvent } from 'rxjs';
import { ColyseusService, type LiveRoomView } from '../../core/game/colyseus.service';
import { AuthService } from '../../core/auth/auth.service';
import { GameSessionService } from '../../core/game/game-session.service';
import { BAR_POINT, OFF_POINT, type NardiPlayerIndex } from '@georgian-games/shared';
import {
  type BoardGeometry,
  computeBoardGeometry,
  computeStackLayout,
  fitBoardSize,
  geometryCssVars,
  stackCssVars,
} from './board-geometry';
import {
  barPlayerOrder,
  displayPointRows,
  perspectiveFromSeat,
  toLogicalPoint,
} from './board-perspective';
import {
  prefersReducedMotion,
  startEndGameCelebration,
} from './end-game-celebration';

@Component({
  selector: 'app-nardi-board',
  standalone: true,
  templateUrl: './nardi-board.component.html',
  styleUrl: './nardi-board.component.scss',
  host: {
    '[class.expanded]': 'expanded()',
    '[class.compact]': 'isCompact()',
    '[attr.data-expanded]': 'expanded() ? "true" : null',
  },
})
export class NardiBoardComponent {
  readonly colyseus = inject(ColyseusService);
  readonly auth = inject(AuthService);
  private readonly session = inject(GameSessionService);
  private readonly router = inject(Router);
  private readonly hostEl = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);

  /** Optional mock view for visual / layout preview (no network). */
  readonly previewView = signal<LiveRoomView | null>(null);
  /** Preview-only: which seat is "local" for perspective QA (0 white / 1 black). */
  readonly previewLocalSeat = signal<NardiPlayerIndex>(0);

  readonly selectedFrom = signal<number | null>(null);
  /** Short-lived Georgian hint after a blocked bar roll auto-pass. */
  readonly barHint = signal<string | null>(null);
  readonly expanded = signal(false);
  readonly geometry = signal<BoardGeometry>(defaultGeometry());
  readonly viewportW = signal(typeof window !== 'undefined' ? window.innerWidth : 1024);
  readonly viewportH = signal(typeof window !== 'undefined' ? window.innerHeight : 768);
  private barHintTimer: ReturnType<typeof setTimeout> | null = null;
  private prevBarSnap: { myTurn: boolean; phase: string; turnNumber: number } | null = null;

  /** End-game overlay (win/loss). Driven once per finished matchId. */
  readonly resultOpen = signal(false);
  readonly resultKind = signal<'win' | 'loss' | null>(null);
  readonly resultCardVisible = signal(false);
  readonly endGameBusy = signal(false);

  private readonly boardStage = viewChild<ElementRef<HTMLElement>>('boardStage');
  private readonly celebrationCanvas = viewChild<ElementRef<HTMLCanvasElement>>('celebrationCanvas');
  private resizeObserver: ResizeObserver | null = null;
  private measureRaf = 0;
  /** Prevents double-submit of roll / recovery pass while waiting for server state. */
  private rollLock = false;
  private passRecoveryKey: string | null = null;
  private handledResultKey: string | null = null;
  private sawLivePlay = false;
  private stopCelebration: (() => void) | null = null;
  private resultCardTimer: ReturnType<typeof setTimeout> | null = null;

  readonly view = computed(() => this.previewView() ?? this.colyseus.view());
  readonly mySeat = computed(() => {
    if (this.previewView()) {
      const seat = this.previewLocalSeat();
      return this.previewView()!.seats.find((s) => s.seatNumber === seat) ?? null;
    }
    return this.colyseus.mySeat();
  });
  readonly isMyTurn = computed(() => {
    if (this.previewView()) return true;
    return this.colyseus.isMyTurn();
  });

  /** Camera: white or black. Derived from local seat — not username. */
  readonly perspective = computed(() =>
    perspectiveFromSeat(this.mySeat()?.seatNumber as NardiPlayerIndex | undefined),
  );

  readonly localSeatNumber = computed<NardiPlayerIndex>(() => {
    const seat = this.mySeat()?.seatNumber;
    return seat === 1 ? 1 : 0;
  });
  readonly opponentSeatNumber = computed<NardiPlayerIndex>(() =>
    this.localSeatNumber() === 0 ? 1 : 0,
  );

  /** Seats ordered local → opponent for chrome that follows perspective. */
  readonly perspectiveSeats = computed(() => {
    const v = this.view();
    if (!v) return [];
    const local = this.localSeatNumber();
    return [...v.seats].sort((a, b) => {
      if (a.seatNumber === local) return -1;
      if (b.seatNumber === local) return 1;
      return a.seatNumber - b.seatNumber;
    });
  });

  readonly isCompact = computed(
    () => this.viewportW() < 900 || this.viewportH() < 540,
  );
  readonly geoCss = computed(() => geometryCssVars(this.geometry()));

  /** Display-slot rows (fixed white-view geometry). Logical ids via logicalPoint(). */
  readonly topPoints = computed(() => [...displayPointRows().top]);
  readonly bottomPoints = computed(() => [...displayPointRows().bottom]);
  readonly topLeftPoints = computed(() => this.topPoints().slice(0, 6));
  readonly topRightPoints = computed(() => this.topPoints().slice(6));
  readonly bottomLeftPoints = computed(() => this.bottomPoints().slice(0, 6));
  readonly bottomRightPoints = computed(() => this.bottomPoints().slice(6));

  /** Center bar: [far/top player, near/bottom player]. */
  readonly barOrder = computed(() => barPlayerOrder(this.perspective()));

  readonly myBarCount = computed(() => this.barCount(this.localSeatNumber()));

  readonly mustEnterFromBar = computed(() => {
    if (!this.isMyTurn() || this.isMatchFinished()) return false;
    const v = this.view();
    if (!v || v.nardiPhase !== 'WAITING_FOR_MOVE') return false;
    if (this.myBarCount() <= 0) return false;
    return (v.legalMoves ?? []).some((m) => m.from === BAR_POINT);
  });

  readonly statusText = computed(() => {
    const hint = this.barHint();
    if (hint) return hint;
    const v = this.view();
    if (!v) return '';
    if (v.phase === 'FINISHED' || v.nardiPhase === 'GAME_OVER') {
      return 'თამაში დასრულდა';
    }
    if (this.mustEnterFromBar()) {
      return 'კენჭი ბარზეა — ჯერ თამაშში უნდა დააბრუნოთ';
    }
    const turnPlayer = v.seats.find((s) => s.seatNumber === v.currentTurn);
    if (v.nardiPhase === 'WAITING_FOR_ROLL') {
      return `${turnPlayer?.username ?? 'მოთამაშე'} — გააგორე კამათელი`;
    }
    return `${turnPlayer?.username ?? 'მოთამაშე'} — გადაადგილება`;
  });

  readonly isMatchFinished = computed(() => {
    const v = this.view();
    if (!v) return false;
    return v.phase === 'FINISHED' || v.nardiPhase === 'GAME_OVER';
  });

  /** Local player outcome from authoritative winnerSeat + seat.userId (not username). */
  readonly localOutcome = computed<'win' | 'loss' | null>(() => {
    if (!this.isMatchFinished()) return null;
    const v = this.view();
    if (!v || v.winnerSeat < 0) return null;
    const winner = v.seats.find((s) => s.seatNumber === v.winnerSeat);
    if (!winner?.userId) return null;
    // Prefer auth user id in live play; in preview use seat 0 as the local player.
    const myId = this.previewView()
      ? this.mySeat()?.userId
      : (this.auth.user()?.id ?? this.mySeat()?.userId ?? null);
    if (!myId) return null;
    return winner.userId === myId ? 'win' : 'loss';
  });

  readonly winnerUsername = computed(() => {
    const v = this.view();
    if (!v || v.winnerSeat < 0) return '';
    return v.seats.find((s) => s.seatNumber === v.winnerSeat)?.username ?? '';
  });

  readonly legalTargets = computed(() => {
    const moves = this.view()?.legalMoves ?? [];
    const from = this.selectedFrom();
    if (from === null) {
      // Mandatory bar entry: highlight destinations without requiring a bar tap.
      if (this.mustEnterFromBar()) {
        return new Set(moves.filter((m) => m.from === BAR_POINT).map((m) => m.to));
      }
      return new Set<number>();
    }
    return new Set(moves.filter((m) => m.from === from).map((m) => m.to));
  });

  constructor() {
    fromEvent(document, 'fullscreenchange')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (!document.fullscreenElement && this.expanded()) {
          this.exitExpanded(false);
        }
      });

    fromEvent(window, 'resize')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.viewportW.set(window.innerWidth);
        this.viewportH.set(window.innerHeight);
        this.scheduleMeasure();
      });

    afterNextRender(() => {
      this.viewportW.set(window.innerWidth);
      this.viewportH.set(window.innerHeight);
      this.attachStageObserver();
      this.scheduleMeasure();
    });

    // Recover if server/client ever land in WAITING_FOR_MOVE with no moves (both players blocked from rolling).
    effect(() => {
      const v = this.view();
      if (!v || this.previewView()) return;
      if (v.phase !== 'PLAYING') return;

      if (v.nardiPhase === 'WAITING_FOR_ROLL') {
        this.rollLock = false;
        this.passRecoveryKey = null;
        return;
      }

      if (v.nardiPhase !== 'WAITING_FOR_MOVE') return;
      if (!this.isMyTurn()) return;
      if ((v.legalMoves?.length ?? 0) > 0) {
        this.passRecoveryKey = null;
        return;
      }

      const key = `${v.matchId}:${v.turnNumber}:${v.currentTurn}:empty`;
      if (this.passRecoveryKey === key) return;
      this.passRecoveryKey = key;

      console.warn('[nardi:stuck] WAITING_FOR_MOVE with zero legalMoves — requesting PASS', {
        playerId: this.auth.user()?.id ?? null,
        currentTurn: v.currentTurn,
        phase: v.nardiPhase,
        dice: v.dice,
        legalMoves: v.legalMoves.length,
        turnNumber: v.turnNumber,
        gameStarted: v.phase === 'PLAYING',
        gameOver: false,
      });
      this.colyseus.pass();
    });

    // Bar re-entry UX: auto-select BAR origin and surface blocked-entry auto-pass hints.
    effect(() => {
      const v = this.view();
      if (!v) return;

      const seat = this.localSeatNumber();
      const myBar = seat === 0 ? v.bar0 : v.bar1;
      const myTurn = this.isMyTurn();
      const snap = {
        myTurn,
        phase: v.nardiPhase,
        turnNumber: v.turnNumber,
      };

      if (
        this.prevBarSnap &&
        this.prevBarSnap.myTurn &&
        this.prevBarSnap.phase === 'WAITING_FOR_ROLL' &&
        !myTurn &&
        v.nardiPhase === 'WAITING_FOR_ROLL' &&
        v.phase === 'PLAYING' &&
        myBar > 0 &&
        v.turnNumber > this.prevBarSnap.turnNumber &&
        (v.dice.d1 > 0 || v.dice.d2 > 0)
      ) {
        // Rolled while on bar with zero legal entries → server auto-passed.
        this.showBarHint('კენჭის დაბრუნება შეუძლებელია — სვლა გადადის მოწინააღმდეგეზე');
      }
      this.prevBarSnap = snap;

      if (v.nardiPhase === 'WAITING_FOR_MOVE' && myTurn && myBar > 0) {
        const hasBarMoves = (v.legalMoves ?? []).some((m) => m.from === BAR_POINT);
        if (hasBarMoves) {
          this.selectedFrom.set(BAR_POINT);
        }
      } else if (this.selectedFrom() === BAR_POINT && myBar <= 0) {
        this.selectedFrom.set(null);
      }
    });

    // End-game result: trigger once per finished match for the local user.
    effect(() => {
      const v = this.view();
      if (!v) return;

      if (v.phase === 'PLAYING' && v.nardiPhase !== 'GAME_OVER') {
        this.sawLivePlay = true;
      }

      const finished = v.phase === 'FINISHED' || v.nardiPhase === 'GAME_OVER';
      if (!finished || v.winnerSeat < 0) return;

      const outcome = this.localOutcome();
      if (!outcome) return;

      const key = `${v.matchId || v.dbRoomId}:${v.winnerSeat}:${outcome}`;
      if (this.handledResultKey === key) return;
      this.handledResultKey = key;

      const celebrateFull = outcome === 'win' && (this.sawLivePlay || !!this.previewView());
      this.openResultExperience(outcome, celebrateFull);
    });

    this.destroyRef.onDestroy(() => {
      if (this.measureRaf) cancelAnimationFrame(this.measureRaf);
      this.resizeObserver?.disconnect();
      this.clearExpandedChrome();
      this.teardownCelebration();
      if (this.resultCardTimer) clearTimeout(this.resultCardTimer);
      if (this.barHintTimer) clearTimeout(this.barHintTimer);
      void this.exitFullscreenSafe();
      void this.unlockOrientationSafe();
    });
  }

  private showBarHint(message: string): void {
    this.barHint.set(message);
    if (this.barHintTimer) clearTimeout(this.barHintTimer);
    this.barHintTimer = setTimeout(() => {
      this.barHint.set(null);
      this.barHintTimer = null;
    }, 3200);
  }

  /** Used by preview page only. */
  setPreview(view: LiveRoomView | null, localSeat: NardiPlayerIndex = 0): void {
    this.teardownCelebration();
    if (this.resultCardTimer) clearTimeout(this.resultCardTimer);
    this.resultCardTimer = null;
    this.handledResultKey = null;
    this.resultOpen.set(false);
    this.resultCardVisible.set(false);
    this.resultKind.set(null);
    this.sawLivePlay = false;
    this.previewLocalSeat.set(localSeat);
    this.selectedFrom.set(null);
    this.previewView.set(view);
  }

  private openResultExperience(kind: 'win' | 'loss', celebrateFull: boolean): void {
    this.selectedFrom.set(null);
    this.resultKind.set(kind);
    this.resultOpen.set(true);
    this.resultCardVisible.set(false);

    const reduced = prefersReducedMotion();
    const showCardDelay = kind === 'win' && celebrateFull && !reduced ? 600 : 80;

    if (kind === 'win' && celebrateFull && !reduced) {
      // Wait until the canvas is in the DOM (*resultOpen).
      queueMicrotask(() => {
        requestAnimationFrame(() => {
          const canvas = this.celebrationCanvas()?.nativeElement;
          if (!canvas) return;
          this.teardownCelebration();
          this.stopCelebration = startEndGameCelebration(canvas, {
            mode: 'victory',
            intensity: 'full',
            reducedMotion: false,
          });
        });
      });
    } else {
      this.teardownCelebration();
    }

    if (this.resultCardTimer) clearTimeout(this.resultCardTimer);
    this.resultCardTimer = setTimeout(() => {
      this.resultCardVisible.set(true);
      this.resultCardTimer = null;
    }, showCardDelay);
  }

  private teardownCelebration(): void {
    this.stopCelebration?.();
    this.stopCelebration = null;
  }

  async onNewGame(): Promise<void> {
    if (this.endGameBusy()) return;
    this.endGameBusy.set(true);
    try {
      this.teardownCelebration();
      if (this.previewView()) {
        this.setPreview(null);
        return;
      }
      await this.session.leave();
      await this.router.navigateByUrl('/lobby');
    } finally {
      this.endGameBusy.set(false);
    }
  }

  async onExitGames(): Promise<void> {
    if (this.endGameBusy()) return;
    this.endGameBusy.set(true);
    try {
      this.teardownCelebration();
      if (this.previewView()) {
        this.setPreview(null);
        return;
      }
      await this.session.leave();
      await this.router.navigateByUrl('/lobby');
    } finally {
      this.endGameBusy.set(false);
    }
  }

  checkersAt(point: number): { player: 0 | 1; count: number } | null {
    const v = this.pointsValue(point);
    if (v === 0) return null;
    return { player: v > 0 ? 0 : 1, count: Math.abs(v) };
  }

  /** Display slot → checkers from the mapped logical point. */
  checkersAtDisplay(displayPoint: number): { player: 0 | 1; count: number } | null {
    return this.checkersAt(this.logicalPoint(displayPoint));
  }

  pointsValue(point: number): number {
    return this.view()?.points[point] ?? 0;
  }

  /** Display slot → canonical logical point for this camera. */
  logicalPoint(displayPoint: number): number {
    return toLogicalPoint(displayPoint, this.perspective());
  }

  isDisplaySelectable(displayPoint: number): boolean {
    return this.isSelectable(this.logicalPoint(displayPoint));
  }

  isDisplayTarget(displayPoint: number): boolean {
    return this.isTarget(this.logicalPoint(displayPoint));
  }

  isDisplaySelected(displayPoint: number): boolean {
    return this.selectedFrom() === this.logicalPoint(displayPoint);
  }

  stackLayout(count: number) {
    const g = this.geometry();
    return computeStackLayout(count, g.checkerSize, g.stackHeight);
  }

  stackStyle(count: number): Record<string, string> {
    return stackCssVars(this.stackLayout(count));
  }

  checkerIndices(count: number): number[] {
    const visible = this.stackLayout(count).visible;
    return Array.from({ length: visible }, (_, i) => i);
  }

  stackBadge(count: number): number {
    return this.stackLayout(count).badge;
  }

  barStackLayout(count: number) {
    const g = this.geometry();
    const barStackH = Math.max(g.stackHeight * 0.85, g.checkerSize);
    // Never coerce empty bar to 1 — that rendered phantom "hit" checkers.
    return computeStackLayout(Math.max(0, count), g.checkerSize * 0.88, barStackH);
  }

  barStackStyle(count: number): Record<string, string> {
    return stackCssVars(this.barStackLayout(count));
  }

  barCheckerIndices(count: number): number[] {
    const visible = this.barStackLayout(count).visible;
    return Array.from({ length: visible }, (_, i) => i);
  }

  barBadge(count: number): number {
    return this.barStackLayout(count).badge;
  }

  /** True when this seat's bar zone should show the mandatory re-entry pulse. */
  isBarMustEnter(player: NardiPlayerIndex): boolean {
    return this.mustEnterFromBar() && this.localSeatNumber() === player;
  }

  isSelectable(point: number): boolean {
    if (this.isMatchFinished()) return false;
    if (!this.isMyTurn()) return false;
    if (this.mySeat()?.seatNumber === undefined && !this.previewView()) return false;
    const moves = this.view()?.legalMoves ?? [];
    return moves.some((m) => m.from === point);
  }

  isTarget(point: number): boolean {
    if (this.isMatchFinished()) return false;
    return this.legalTargets().has(point);
  }

  /**
   * Point buttons bind DISPLAY slot ids (white-view geometry).
   * Convert to logical before selection / server moves.
   */
  onPointClick(displayPoint: number): void {
    if (this.isMatchFinished()) return;
    if (!this.isMyTurn()) return;
    const logical = toLogicalPoint(displayPoint, this.perspective());
    if (this.previewView()) {
      this.selectedFrom.set(this.selectedFrom() === logical ? null : logical);
      return;
    }

    const selected = this.selectedFrom();
    const moves = this.view()?.legalMoves ?? [];

    // One-tap bar re-entry: destination click while bar has absolute priority.
    if (
      this.mustEnterFromBar() &&
      moves.some((m) => m.from === BAR_POINT && m.to === logical)
    ) {
      this.colyseus.moveChecker(BAR_POINT, logical);
      this.selectedFrom.set(null);
      return;
    }

    if (selected !== null && this.legalTargets().has(logical)) {
      this.colyseus.moveChecker(selected, logical);
      this.selectedFrom.set(null);
      return;
    }

    if (moves.some((m) => m.from === logical)) {
      this.selectedFrom.set(logical);
      return;
    }

    this.selectedFrom.set(null);
  }

  barCount(player: NardiPlayerIndex): number {
    const v = this.view();
    if (!v) return 0;
    return player === 0 ? v.bar0 : v.bar1;
  }

  offCount(player: NardiPlayerIndex): number {
    const v = this.view();
    if (!v) return 0;
    return player === 0 ? v.off0 : v.off1;
  }

  onBarClick(player: 0 | 1): void {
    if (this.isMatchFinished()) return;
    if (this.previewView()) {
      if (this.barCount(player) > 0) this.selectedFrom.set(BAR_POINT);
      return;
    }
    if (this.mySeat()?.seatNumber !== player) return;
    if (!this.isMyTurn()) return;
    if (this.barCount(player) <= 0) return;
    const moves = this.view()?.legalMoves ?? [];
    if (moves.some((m) => m.from === BAR_POINT)) {
      this.selectedFrom.set(BAR_POINT);
    }
  }

  bearOff(): void {
    if (this.isMatchFinished()) return;
    if (this.previewView()) return;
    const from = this.selectedFrom();
    if (from === null) return;
    if (!this.legalTargets().has(OFF_POINT)) return;
    this.colyseus.moveChecker(from, OFF_POINT);
    this.selectedFrom.set(null);
  }

  canBearOff(): boolean {
    if (this.previewView() || this.isMatchFinished()) return false;
    return this.selectedFrom() !== null && this.legalTargets().has(OFF_POINT);
  }

  roll(): void {
    if (this.previewView() || this.isMatchFinished()) return;
    console.info('[dice:click]');
    if (!this.canRoll()) return;
    if (this.rollLock) return;
    this.rollLock = true;
    this.selectedFrom.set(null);
    console.info('[dice:roll-request]', {
      currentTurn: this.view()?.currentTurn,
      phase: this.view()?.nardiPhase,
      seat: this.mySeat()?.seatNumber,
    });
    this.colyseus.rollDice();
    // Unlock if the server rejects / state never leaves the roll phase.
    window.setTimeout(() => {
      if (this.view()?.nardiPhase === 'WAITING_FOR_ROLL') {
        this.rollLock = false;
      }
    }, 1200);
  }

  onRollPointerDown(): void {
    console.info('[dice:pointerdown]', { canRoll: this.canRoll(), disabled: !this.canRoll() });
  }

  canRoll(): boolean {
    if (this.previewView() || this.isMatchFinished()) return false;
    if (this.rollLock) return false;
    const v = this.view();
    if (!v) return false;
    return (
      this.isMyTurn() &&
      v.phase === 'PLAYING' &&
      v.nardiPhase === 'WAITING_FOR_ROLL' &&
      !v.dice.rolled
    );
  }

  dicePips(value: number): number[] {
    const slots: Record<number, number[]> = {
      1: [5],
      2: [1, 9],
      3: [1, 5, 9],
      4: [1, 3, 7, 9],
      5: [1, 3, 5, 7, 9],
      6: [1, 3, 4, 6, 7, 9],
    };
    return slots[value] ?? [];
  }

  playerName(seatNumber: number): string {
    return this.view()?.seats.find((seat) => seat.seatNumber === seatNumber)?.username
      ?? `მოთამაშე ${seatNumber + 1}`;
  }

  async toggleExpanded(): Promise<void> {
    if (this.expanded()) {
      await this.exitExpanded(true);
      return;
    }
    await this.enterExpanded();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.resultOpen()) return;
    if (this.expanded()) {
      void this.exitExpanded(true);
    }
  }

  private attachStageObserver(): void {
    const el = this.boardStage()?.nativeElement;
    if (!el || typeof ResizeObserver === 'undefined') return;
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.scheduleMeasure());
    this.resizeObserver.observe(el);
  }

  private scheduleMeasure(): void {
    if (this.measureRaf) cancelAnimationFrame(this.measureRaf);
    this.measureRaf = requestAnimationFrame(() => {
      this.measureRaf = 0;
      this.measureBoard();
      if (!this.resizeObserver) this.attachStageObserver();
    });
  }

  private measureBoard(): void {
    const stage = this.boardStage()?.nativeElement;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width < 32 || rect.height < 32) return;

    const fitted = fitBoardSize({ stageWidth: rect.width, stageHeight: rect.height });
    if (fitted.width < 32) return;
    this.geometry.set(computeBoardGeometry(fitted.width, fitted.height));
  }

  private async enterExpanded(): Promise<void> {
    this.expanded.set(true);
    document.body.classList.add('nardi-expanded');
    await this.requestFullscreenSafe(this.hostEl.nativeElement);
    await this.lockLandscapeSafe();
    requestAnimationFrame(() => {
      this.scheduleMeasure();
      setTimeout(() => this.scheduleMeasure(), 120);
    });
  }

  private async exitExpanded(exitFs: boolean): Promise<void> {
    this.expanded.set(false);
    this.clearExpandedChrome();
    await this.unlockOrientationSafe();
    if (exitFs) await this.exitFullscreenSafe();
    requestAnimationFrame(() => this.scheduleMeasure());
  }

  private clearExpandedChrome(): void {
    document.body.classList.remove('nardi-expanded');
  }

  private async requestFullscreenSafe(el: HTMLElement): Promise<void> {
    const anyEl = el as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
    };
    try {
      if (document.fullscreenElement) return;
      if (el.requestFullscreen) {
        await el.requestFullscreen();
      } else if (anyEl.webkitRequestFullscreen) {
        await Promise.resolve(anyEl.webkitRequestFullscreen());
      }
    } catch {
      /* overlay fallback */
    }
  }

  private async exitFullscreenSafe(): Promise<void> {
    const doc = document as Document & {
      webkitExitFullscreen?: () => Promise<void> | void;
    };
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (doc.webkitExitFullscreen) {
        await Promise.resolve(doc.webkitExitFullscreen());
      }
    } catch {
      /* ignore */
    }
  }

  private async lockLandscapeSafe(): Promise<void> {
    try {
      const orientation = screen.orientation as ScreenOrientation & {
        lock?: (o: string) => Promise<void>;
      };
      if (typeof orientation?.lock === 'function') {
        await orientation.lock('landscape');
      }
    } catch {
      /* CSS layout still works without lock */
    }
  }

  private async unlockOrientationSafe(): Promise<void> {
    try {
      screen.orientation?.unlock?.();
    } catch {
      /* ignore */
    }
  }

  readonly BAR = BAR_POINT;
  readonly OFF = OFF_POINT;
}

function defaultGeometry(): BoardGeometry {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 390;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 700;
  const stageW = Math.max(280, Math.min(vw - 16, 1120));
  const stageH = Math.max(160, Math.min(vh * 0.55, stageW / 1.78 + 8));
  const fitted = fitBoardSize({ stageWidth: stageW, stageHeight: stageH });
  return computeBoardGeometry(fitted.width, fitted.height);
}
