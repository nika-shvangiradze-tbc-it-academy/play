import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ColyseusService } from '../../core/game/colyseus.service';
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
  readonly colyseus = inject(ColyseusService);
  readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly copied = signal(false);
  readonly inviteCode = signal('');

  readonly view = this.colyseus.view;
  readonly mySeat = this.colyseus.mySeat;
  readonly isPlaying = computed(() => this.view()?.phase === 'PLAYING' || this.view()?.phase === 'FINISHED');
  readonly isHost = computed(() => {
    const v = this.view();
    const uid = this.auth.user()?.id;
    return !!v && !!uid && v.hostUserId === uid;
  });

  ngOnInit(): void {
    const code = this.route.snapshot.paramMap.get('inviteCode') ?? '';
    this.inviteCode.set(code);
    if (!this.colyseus.connected()) {
      void this.router.navigateByUrl('/lobby');
    }
  }

  ngOnDestroy(): void {
    // Keep connection while navigating within match; leave explicitly via button
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
    if (seat.isReady) this.colyseus.unready();
    else this.colyseus.ready();
  }

  async leave(): Promise<void> {
    this.colyseus.leaveRoom();
    await this.colyseus.leave();
    await this.router.navigateByUrl('/lobby');
  }

  seatLabel(index: number): string {
    const seats = this.view()?.seats ?? [];
    return seats.find((s) => s.seatNumber === index)?.username ?? 'Waiting for player…';
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
    if (seat.reconnecting) return 'Disconnected — waiting for reconnection';
    if (!seat.connected) return 'Offline';
    return seat.isReady ? 'READY ✓' : 'Not ready';
  }
}
