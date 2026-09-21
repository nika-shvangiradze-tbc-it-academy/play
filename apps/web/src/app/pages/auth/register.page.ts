import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';

@Component({
  selector: 'app-register-page',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './register.page.html',
  styleUrl: './auth-shared.scss',
})
export class RegisterPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  username = '';
  email = '';
  password = '';
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    const { error } = await this.auth.signUp(this.username, this.email, this.password);
    this.busy.set(false);
    if (error) {
      this.error.set(error);
      return;
    }
    await this.router.navigateByUrl('/lobby');
  }
}
