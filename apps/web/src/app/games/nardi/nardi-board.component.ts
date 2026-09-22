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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { fromEvent } from 'rxjs';
import { ColyseusService, type LiveRoomView } from '../../core/game/colyseus.service';
import { AuthService } from '../../core/auth/auth.service';
import { BAR_POINT, OFF_POINT } from '@georgian-games/shared';
import {
  type BoardGeometry,
  computeBoardGeometry,
  computeStackLayout,
  fitBoardSize,
  geometryCssVars,
  stackCssVars,
} from './board-geometry';

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
  private readonly hostEl = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);

  /** Optional mock view for visual / layout preview (no network). */
  readonly previewView = signal<LiveRoomView | null>(null);

  readonly selectedFrom = signal<number | null>(null);
  readonly expanded = signal(false);
  readonly geometry = signal<BoardGeometry>(defaultGeometry());
  readonly viewportW = signal(typeof window !== 'undefined' ? window.innerWidth : 1024);
  readonly viewportH = signal(typeof window !== 'undefined' ? window.innerHeight : 768);

  private readonly boardStage = viewChild<ElementRef<HTMLElement>>('boardStage');
  private resizeObserver: ResizeObserver | null = null;
  private measureRaf = 0;
  /** Prevents double-submit of roll / recovery pass while waiting for server state. */
  private rollLock = false;
  private passRecoveryKey: string | null = null;

  readonly view = computed(() => this.previewView() ?? this.colyseus.view());
  readonly mySeat = computed(() => {
    if (this.previewView()) {
      return this.previewView()!.seats[0] ?? null;
    }
    return this.colyseus.mySeat();
  });
  readonly isMyTurn = computed(() => {
    if (this.previewView()) return true;
    return this.colyseus.isMyTurn();
  });

  readonly isCompact = computed(
    () => this.viewportW() < 900 || this.viewportH() < 540,
  );
  readonly geoCss = computed(() => geometryCssVars(this.geometry()));

  readonly topPoints = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
  readonly bottomPoints = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  readonly topLeftPoints = this.topPoints.slice(0, 6);
  readonly topRightPoints = this.topPoints.slice(6);
  readonly bottomLeftPoints = this.bottomPoints.slice(0, 6);
  readonly bottomRightPoints = this.bottomPoints.slice(6);

  readonly statusText = computed(() => {
    const v = this.view();
    if (!v) return '';
    if (v.phase === 'FINISHED' || v.nardiPhase === 'GAME_OVER') {
      const winner = v.seats.find((s) => s.seatNumber === v.winnerSeat);
      return winner ? `${winner.username} wins!` : 'Match finished';
    }
    const turnPlayer = v.seats.find((s) => s.seatNumber === v.currentTurn);
    if (v.nardiPhase === 'WAITING_FOR_ROLL') {
      return `${turnPlayer?.username ?? 'Player'} — roll dice`;
    }
    return `${turnPlayer?.username ?? 'Player'} — move`;
  });

  readonly legalTargets = computed(() => {
    const from = this.selectedFrom();
    const moves = this.view()?.legalMoves ?? [];
    if (from === null) return new Set<number>();
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

    this.destroyRef.onDestroy(() => {
      if (this.measureRaf) cancelAnimationFrame(this.measureRaf);
      this.resizeObserver?.disconnect();
      this.clearExpandedChrome();
      void this.exitFullscreenSafe();
      void this.unlockOrientationSafe();
    });
  }

  /** Used by preview page only. */
  setPreview(view: LiveRoomView | null): void {
    this.previewView.set(view);
  }

  checkersAt(point: number): { player: 0 | 1; count: number } | null {
    const v = this.pointsValue(point);
    if (v === 0) return null;
    return { player: v > 0 ? 0 : 1, count: Math.abs(v) };
  }

  pointsValue(point: number): number {
    return this.view()?.points[point] ?? 0;
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
    return computeStackLayout(count || 1, g.checkerSize * 0.88, barStackH);
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

  isSelectable(point: number): boolean {
    if (!this.isMyTurn()) return false;
    if (this.mySeat()?.seatNumber === undefined && !this.previewView()) return false;
    const moves = this.view()?.legalMoves ?? [];
    return moves.some((m) => m.from === point);
  }

  isTarget(point: number): boolean {
    return this.legalTargets().has(point);
  }

  onPointClick(point: number): void {
    if (!this.isMyTurn()) return;
    if (this.previewView()) {
      this.selectedFrom.set(this.selectedFrom() === point ? null : point);
      return;
    }

    const selected = this.selectedFrom();
    const moves = this.view()?.legalMoves ?? [];

    if (selected !== null && this.legalTargets().has(point)) {
      this.colyseus.moveChecker(selected, point);
      this.selectedFrom.set(null);
      return;
    }

    if (moves.some((m) => m.from === point)) {
      this.selectedFrom.set(point);
      return;
    }

    this.selectedFrom.set(null);
  }

  onBarClick(player: 0 | 1): void {
    if (this.previewView()) return;
    if (this.mySeat()?.seatNumber !== player) return;
    if (!this.isMyTurn()) return;
    const moves = this.view()?.legalMoves ?? [];
    if (moves.some((m) => m.from === BAR_POINT)) {
      this.selectedFrom.set(BAR_POINT);
    }
  }

  bearOff(): void {
    if (this.previewView()) return;
    const from = this.selectedFrom();
    if (from === null) return;
    if (!this.legalTargets().has(OFF_POINT)) return;
    this.colyseus.moveChecker(from, OFF_POINT);
    this.selectedFrom.set(null);
  }

  canBearOff(): boolean {
    if (this.previewView()) return false;
    return this.selectedFrom() !== null && this.legalTargets().has(OFF_POINT);
  }

  roll(): void {
    if (this.previewView()) return;
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
    if (this.previewView()) return false;
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
      ?? `Player ${seatNumber + 1}`;
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
