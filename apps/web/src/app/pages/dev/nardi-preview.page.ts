import { Component, OnInit, viewChild } from '@angular/core';
import { createInitialBoard } from '@georgian-games/shared';
import { NardiBoardComponent } from '../../games/nardi/nardi-board.component';
import type { LiveRoomView } from '../../core/game/colyseus.service';

/** Dev-only board preview for layout / viewport QA (no auth, no network). */
@Component({
  selector: 'app-nardi-preview-page',
  standalone: true,
  imports: [NardiBoardComponent],
  template: `
    <div class="preview-page">
      <div class="preview-controls">
        <label>
          Scenario
          <select [value]="scenario" (change)="onScenario($event)">
            <option value="initial">Initial position</option>
            <option value="stacks">Stress stacks</option>
            <option value="bar">Bar + mid-game</option>
            <option value="bearoff">Bearing off</option>
          </select>
        </label>
        <span class="hint">Visual QA — not a live match</span>
      </div>
      <app-nardi-board />
    </div>
  `,
  styles: `
    .preview-page {
      min-height: 100%;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .preview-controls {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
      font-size: 0.8rem;
      color: var(--muted);
    }
    select {
      margin-left: 0.35rem;
      padding: 0.35rem 0.5rem;
      border-radius: 8px;
      border: 1px solid var(--border-subtle);
      background: rgba(0, 0, 0, 0.35);
      color: var(--cream);
    }
    .hint { opacity: 0.7; }
  `,
})
export class NardiPreviewPage implements OnInit {
  private readonly board = viewChild.required(NardiBoardComponent);
  scenario: 'initial' | 'stacks' | 'bar' | 'bearoff' = 'stacks';

  ngOnInit(): void {
    queueMicrotask(() => this.applyScenario(this.scenario));
  }

  onScenario(ev: Event): void {
    const value = (ev.target as HTMLSelectElement).value as typeof this.scenario;
    this.scenario = value;
    this.applyScenario(value);
  }

  private applyScenario(name: typeof this.scenario): void {
    this.board().setPreview(buildPreview(name));
  }
}

function baseView(partial: Partial<LiveRoomView> & { points: number[] }): LiveRoomView {
  return {
    dbRoomId: 'preview',
    inviteCode: 'PREVIEW',
    gameType: 'nardi',
    phase: 'PLAYING',
    hostUserId: 'p0',
    maxPlayers: 2,
    matchId: 'preview',
    nardiPhase: 'MOVING',
    currentTurn: 0,
    turnNumber: 3,
    winnerSeat: -1,
    dice: { d1: 4, d2: 2, rolled: true, remaining: [4, 2] },
    bar0: 0,
    bar1: 0,
    off0: 0,
    off1: 0,
    seats: [
      {
        userId: 'p0',
        username: 'White',
        seatNumber: 0,
        isReady: true,
        connected: true,
        reconnecting: false,
      },
      {
        userId: 'p1',
        username: 'Black',
        seatNumber: 1,
        isReady: true,
        connected: true,
        reconnecting: false,
      },
    ],
    legalMoves: [
      { from: 13, to: 9, die: 4, hit: false },
      { from: 13, to: 11, die: 2, hit: false },
    ],
    ...partial,
  };
}

function buildPreview(name: 'initial' | 'stacks' | 'bar' | 'bearoff'): LiveRoomView {
  if (name === 'initial') {
    const board = createInitialBoard();
    return baseView({
      points: board.points,
      bar0: board.bar[0],
      bar1: board.bar[1],
      off0: board.off[0],
      off1: board.off[1],
      nardiPhase: 'WAITING_FOR_ROLL',
      dice: { d1: 0, d2: 0, rolled: false, remaining: [] },
      legalMoves: [],
    });
  }

  if (name === 'stacks') {
    const points = new Array<number>(25).fill(0);
    points[24] = 1;
    points[23] = 2;
    points[22] = 3;
    points[21] = 4;
    points[20] = 5;
    points[19] = 6;
    points[18] = 8;
    points[13] = 10;
    points[1] = -1;
    points[2] = -2;
    points[3] = -3;
    points[4] = -4;
    points[5] = -5;
    points[6] = -8;
    points[12] = -15;
    return baseView({ points, legalMoves: [{ from: 13, to: 9, die: 4, hit: false }] });
  }

  if (name === 'bar') {
    const points = new Array<number>(25).fill(0);
    points[24] = 2;
    points[13] = 4;
    points[8] = 3;
    points[6] = 3;
    points[1] = -2;
    points[12] = -4;
    points[17] = -3;
    points[19] = -3;
    return baseView({
      points,
      bar0: 2,
      bar1: 1,
      off0: 1,
      off1: 2,
      legalMoves: [{ from: 0, to: 22, die: 4, hit: false }],
    });
  }

  const points = new Array<number>(25).fill(0);
  points[6] = 3;
  points[5] = 2;
  points[4] = 2;
  points[3] = 1;
  points[2] = 1;
  points[1] = 1;
  points[19] = -3;
  points[20] = -2;
  points[21] = -2;
  points[22] = -1;
  points[23] = -1;
  points[24] = -1;
  return baseView({
    points,
    off0: 5,
    off1: 5,
    legalMoves: [{ from: 4, to: 25, die: 4, hit: false }],
  });
}
