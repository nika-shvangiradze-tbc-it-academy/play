import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth/auth.service';

@Component({
  selector: 'app-profile-page',
  standalone: true,
  imports: [FormsModule, DatePipe],
  templateUrl: './profile.page.html',
  styleUrl: './profile.page.scss',
})
export class ProfilePage {
  readonly auth = inject(AuthService);

  username = '';
  avatarUrl = '';

  constructor() {
    effect(() => {
      const p = this.auth.profile();
      if (p) {
        this.username = p.username;
        this.avatarUrl = p.avatar_url ?? '';
      }
    });
  }
  readonly error = signal<string | null>(null);
  readonly success = signal<string | null>(null);
  readonly busy = signal(false);

  readonly losses = computed(() => {
    const p = this.auth.profile();
    if (!p) return 0;
    return Math.max(0, p.games_played - p.games_won);
  });

  readonly winRate = computed(() => {
    const p = this.auth.profile();
    if (!p || p.games_played === 0) return '0%';
    return `${Math.round((p.games_won / p.games_played) * 100)}%`;
  });

  async save(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.success.set(null);
    const { error } = await this.auth.updateProfile({
      username: this.username,
      avatar_url: this.avatarUrl.trim() || null,
    });
    this.busy.set(false);
    if (error) {
      this.error.set(error);
      return;
    }
    this.success.set('პროფილი განახლდა');
  }
}
