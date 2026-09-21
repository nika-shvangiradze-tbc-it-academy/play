import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';

@Component({
  selector: 'app-forgot-password-page',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './forgot-password.page.html',
  styleUrl: './auth-shared.scss',
})
export class ForgotPasswordPage {
  private readonly auth = inject(AuthService);

  email = '';
  readonly error = signal<string | null>(null);
  readonly success = signal(false);
  readonly busy = signal(false);

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.success.set(false);
    const { error } = await this.auth.resetPassword(this.email);
    this.busy.set(false);
    if (error) {
      this.error.set(error);
      return;
    }
    this.success.set(true);
  }
}
