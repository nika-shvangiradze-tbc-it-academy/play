import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth/auth.service';
import { GameSessionService } from './core/game/game-session.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {
  readonly auth = inject(AuthService);
  private readonly session = inject(GameSessionService);
  private readonly router = inject(Router);

  async logout(): Promise<void> {
    try {
      await this.session.leave();
    } catch {
      /* ignore leave errors during logout */
    }
    await this.auth.signOut();
    await this.router.navigateByUrl('/');
  }
}
