import { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/auth/auth.guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/home/home.page').then((m) => m.HomePage),
  },
  {
    path: 'login',
    canActivate: [guestGuard],
    loadComponent: () => import('./pages/auth/login.page').then((m) => m.LoginPage),
  },
  {
    path: 'register',
    canActivate: [guestGuard],
    loadComponent: () => import('./pages/auth/register.page').then((m) => m.RegisterPage),
  },
  {
    path: 'forgot-password',
    canActivate: [guestGuard],
    loadComponent: () =>
      import('./pages/auth/forgot-password.page').then((m) => m.ForgotPasswordPage),
  },
  {
    path: 'lobby',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/lobby/lobby.page').then((m) => m.LobbyPage),
  },
  {
    path: 'room/:inviteCode',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/room/room.page').then((m) => m.RoomPage),
  },
  {
    path: 'history',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/history/history.page').then((m) => m.HistoryPage),
  },
  {
    path: 'profile',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/profile/profile.page').then((m) => m.ProfilePage),
  },
  {
    path: 'dev/nardi-board',
    loadComponent: () =>
      import('./pages/dev/nardi-preview.page').then((m) => m.NardiPreviewPage),
  },
  { path: '**', redirectTo: '' },
];
