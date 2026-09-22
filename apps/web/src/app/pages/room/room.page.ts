import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { GameSessionService } from '../../core/game/game-session.service';
import { AuthService } from '../../core/auth/auth.service';
import { NardiBoardComponent } from '../../games/nardi/nardi-board.component';

@Component({
  selector: 'app-room-page',
  standalone: true,
  imports: [NardiBoardComponent],
  templateUrl: './room.page.html',
  styleUrl: './room.page.scss',
})
export class RoomPage implements OnInit, OnDestroy {
  readonly session = inject(GameSessionService);
  readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly copied = signal(false);
  readonly inviteCode = signal('');

  readonly view = this.session.view;
  readonly mySeat = this.session.mySeat;
  readonly connected = this.session.connected;
  readonly socketOpen = this.session.socketOpen;
  readonly isPlaying = computed(() => this.view()?.phase === 'PLAYING' || this.view()?.phase === 'FINISHED');
  readonly isHost = computed(() => {
    const v = this.view();
    const uid = this.auth.user()?.id;
    return !!v && !!uid && v.hostUserId === uid;
  });

  ngOnInit(): void {
    const code = this.route.snapshot.paramMap.get('inviteCode') ?? '';
    this.inviteCode.set(code);
    // Connection is owned by GameSessionService — do not leave on route init.
    if (!this.session.connected() && !this.session.socketOpen()) {
      void this.router.navigateByUrl('/lobby');
    }
  }

  ngOnDestroy(): void {
    // Keep the Colyseus Room on GameSessionService across navigations.
    // Explicit leave is only via the Leave button / logout.
  }

  async copyCode(): Promise<void> {
    const code = this.view()?.inviteCode || this.inviteCode();
    try {
      await navigator.clipboard.writeText(code);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1600);
    } catch {
      /* ignore */
    }
  }

  toggleReady(): void {
    const seat = this.mySeat();
    if (!seat) return;
    if (seat.isReady) this.session.unready();
    else this.session.ready();
  }

  async leave(): Promise<void> {
    await this.session.leave();
    await this.router.navigateByUrl('/lobby');
  }

  seatLabel(index: number): string {
    const seats = this.view()?.seats ?? [];
    return seats.find((s) => s.seatNumber === index)?.username ?? 'მოთამაშის მოლოდინი…';
  }

  seatReady(index: number): boolean {
    return !!this.view()?.seats.find((s) => s.seatNumber === index)?.isReady;
  }

  seatPresent(index: number): boolean {
    return !!this.view()?.seats.find((s) => s.seatNumber === index);
  }

  seatStatus(index: number): string {
    const seat = this.view()?.seats.find((s) => s.seatNumber === index);
    if (!seat) return '';
    if (seat.reconnecting) return 'გათიშულია — ხელახალი დაკავშირების მოლოდინი';
    if (!seat.connected) return 'ოფლაინ';
    return seat.isReady ? 'მზადაა ✓' : 'არ არის მზად';
  }
}
