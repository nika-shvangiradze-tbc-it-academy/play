import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  // Wait briefly for session hydration
  const start = Date.now();
  while (!auth.ready() && Date.now() - start < 5000) {
    await new Promise((r) => setTimeout(r, 50));
  }

  if (auth.isAuthenticated()) {
    return true;
  }
  return router.createUrlTree(['/login']);
};

export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const start = Date.now();
  while (!auth.ready() && Date.now() - start < 5000) {
    await new Promise((r) => setTimeout(r, 50));
  }

  if (!auth.isAuthenticated()) {
    return true;
  }
  return router.createUrlTree(['/lobby']);
};
