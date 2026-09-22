import { Component, OnInit, inject, viewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { createInitialBoard, type NardiPlayerIndex } from '@georgian-games/shared';
import { NardiBoardComponent } from '../../games/nardi/nardi-board.component';
import type { LiveRoomView } from '../../core/game/colyseus.service';

type PreviewScenario = 'initial' | 'stacks' | 'bar' | 'bearoff' | 'win' | 'loss';

/** Dev-only board preview for layout / viewport QA (no auth, no network). */
@Component({
  selector: 'app-nardi-preview-page',
  standalone: true,
  imports: [NardiBoardComponent],
  template: `
    <div class="preview-page">
      <div class="preview-controls">
        <label>
          სცენარი
          <select [value]="scenario" (change)="onScenario($event)">
            <option value="initial">საწყისი პოზიცია</option>
            <option value="stacks">დატვირთული სტეკები</option>
            <option value="bar">ბარი + შუა თამაში</option>
            <option value="bearoff">გამოტანა</option>
            <option value="win">დასასრული — ადგილობრივი მოგება</option>
            <option value="loss">დასასრული — ადგილობრივი წაგება</option>
          </select>
        </label>
        <label>
          ადგილობრივი ადგილი
          <select [value]="localSeat" (change)="onSeat($event)">
            <option value="0">თეთრი (ადგილი 0)</option>
            <option value="1">შავი (ადგილი 1)</option>
          </select>
        </label>
        <span class="hint">ვიზუალური შემოწმება — არ არის ცოცხალი მატჩი</span>
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
  private readonly route = inject(ActivatedRoute);
  scenario: PreviewScenario = 'stacks';
  localSeat: NardiPlayerIndex = 0;

  ngOnInit(): void {
    const q = this.route.snapshot.queryParamMap.get('scenario') as PreviewScenario | null;
    if (q && ['initial', 'stacks', 'bar', 'bearoff', 'win', 'loss'].includes(q)) {
      this.scenario = q;
    }
    const seatQ = this.route.snapshot.queryParamMap.get('asSeat');
    if (seatQ === '1') this.localSeat = 1;
    if (seatQ === '0') this.localSeat = 0;
    // End-game loss as white was “opponent won”; as dark, flip so local still loses when needed.
    queueMicrotask(() => this.applyScenario(this.scenario));
  }

  onScenario(ev: Event): void {
    const value = (ev.target as HTMLSelectElement).value as PreviewScenario;
    this.scenario = value;
    this.applyScenario(value);
  }

  onSeat(ev: Event): void {
    this.localSeat = Number((ev.target as HTMLSelectElement).value) === 1 ? 1 : 0;
    this.applyScenario(this.scenario);
  }

  private applyScenario(name: PreviewScenario): void {
    this.board().setPreview(buildPreview(name, this.localSeat), this.localSeat);
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
    nardiPhase: 'WAITING_FOR_MOVE',
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
        username: 'tatulika01',
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

function finishedBoard(): number[] {
  const points = new Array<number>(25).fill(0);
  points[6] = 2;
  points[19] = -4;
  points[20] = -3;
  return points;
}

function buildPreview(name: PreviewScenario, localSeat: NardiPlayerIndex): LiveRoomView {
  if (name === 'initial') {
    const board = createInitialBoard();
    return baseView({
      points: board.points,
      bar0: board.bar[0],
      bar1: board.bar[1],
      off0: board.off[0],
      off1: board.off[1],
      nardiPhase: 'WAITING_FOR_ROLL',
      currentTurn: localSeat,
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
    return baseView({
      points,
      currentTurn: localSeat,
      legalMoves:
        localSeat === 0
          ? [{ from: 13, to: 9, die: 4, hit: false }]
          : [{ from: 12, to: 16, die: 4, hit: false }],
    });
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
      currentTurn: localSeat,
      legalMoves:
        localSeat === 0
          ? [{ from: 0, to: 22, die: 4, hit: false }]
          : [{ from: 0, to: 4, die: 4, hit: false }],
    });
  }

  if (name === 'win') {
    return baseView({
      points: finishedBoard(),
      phase: 'FINISHED',
      nardiPhase: 'GAME_OVER',
      winnerSeat: localSeat,
      matchId: 'preview-win',
      off0: localSeat === 0 ? 15 : 8,
      off1: localSeat === 1 ? 15 : 8,
      dice: { d1: 6, d2: 6, rolled: false, remaining: [] },
      legalMoves: [],
    });
  }

  if (name === 'loss') {
    const winner = localSeat === 0 ? 1 : 0;
    return baseView({
      points: finishedBoard(),
      phase: 'FINISHED',
      nardiPhase: 'GAME_OVER',
      winnerSeat: winner,
      matchId: 'preview-loss',
      off0: winner === 0 ? 15 : 8,
      off1: winner === 1 ? 15 : 8,
      dice: { d1: 3, d2: 5, rolled: false, remaining: [] },
      legalMoves: [],
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
    currentTurn: localSeat,
    legalMoves:
      localSeat === 0
        ? [{ from: 4, to: 25, die: 4, hit: false }]
        : [{ from: 21, to: 25, die: 4, hit: false }],
  });
}
