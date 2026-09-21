import { Component, computed, inject, signal } from '@angular/core';
import { ColyseusService } from '../../core/game/colyseus.service';
import { AuthService } from '../../core/auth/auth.service';
import { BAR_POINT, OFF_POINT } from '@georgian-games/shared';

@Component({
  selector: 'app-nardi-board',
  standalone: true,
  templateUrl: './nardi-board.component.html',
  styleUrl: './nardi-board.component.scss',
})
export class NardiBoardComponent {
  readonly colyseus = inject(ColyseusService);
  readonly auth = inject(AuthService);

  readonly selectedFrom = signal<number | null>(null);

  readonly view = this.colyseus.view;
  readonly mySeat = this.colyseus.mySeat;
  readonly isMyTurn = this.colyseus.isMyTurn;

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

  checkersAt(point: number): { player: 0 | 1; count: number } | null {
    const v = this.pointsValue(point);
    if (v === 0) return null;
    return { player: v > 0 ? 0 : 1, count: Math.abs(v) };
  }

  pointsValue(point: number): number {
    return this.view()?.points[point] ?? 0;
  }

  isSelectable(point: number): boolean {
    if (!this.isMyTurn()) return false;
    const seat = this.mySeat()?.seatNumber;
    if (seat === undefined) return false;
    const moves = this.view()?.legalMoves ?? [];
    return moves.some((m) => m.from === point);
  }

  isTarget(point: number): boolean {
    return this.legalTargets().has(point);
  }

  onPointClick(point: number): void {
    if (!this.isMyTurn()) return;
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
    if (this.mySeat()?.seatNumber !== player) return;
    if (!this.isMyTurn()) return;
    const moves = this.view()?.legalMoves ?? [];
    if (moves.some((m) => m.from === BAR_POINT)) {
      this.selectedFrom.set(BAR_POINT);
    }
  }

  bearOff(): void {
    const from = this.selectedFrom();
    if (from === null) return;
    if (!this.legalTargets().has(OFF_POINT)) return;
    this.colyseus.moveChecker(from, OFF_POINT);
    this.selectedFrom.set(null);
  }

  canBearOff(): boolean {
    return this.selectedFrom() !== null && this.legalTargets().has(OFF_POINT);
  }

  roll(): void {
    this.selectedFrom.set(null);
    this.colyseus.rollDice();
  }

  canRoll(): boolean {
    return this.isMyTurn() && this.view()?.nardiPhase === 'WAITING_FOR_ROLL';
  }

  checkerArray(count: number): number[] {
    const n = Math.min(count, 5);
    return Array.from({ length: n }, (_, i) => i);
  }

  overflow(count: number): number {
    return count > 5 ? count : 0;
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

  readonly BAR = BAR_POINT;
  readonly OFF = OFF_POINT;
}
