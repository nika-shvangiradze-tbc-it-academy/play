import { Injectable, signal, computed } from '@angular/core';
import {
  createClient,
  type AuthChangeEvent,
  type Session,
  type SupabaseClient,
  type User,
} from '@supabase/supabase-js';
import { normalizeUsername, validateUsername, type Profile } from '@georgian-games/shared';
import { environment } from '../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly supabase: SupabaseClient = createClient(
    environment.supabaseUrl,
    environment.supabaseAnonKey,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    },
  );

  readonly session = signal<Session | null>(null);
  readonly user = signal<User | null>(null);
  readonly profile = signal<Profile | null>(null);
  readonly loading = signal(true);
  readonly ready = signal(false);

  readonly isAuthenticated = computed(() => !!this.session());
  readonly accessToken = computed(() => this.session()?.access_token ?? null);

  constructor() {
    void this.init();
  }

  private async init(): Promise<void> {
    const { data } = await this.supabase.auth.getSession();
    this.applySession(data.session);
    this.supabase.auth.onAuthStateChange((_event: AuthChangeEvent, session) => {
      this.applySession(session);
    });
    this.loading.set(false);
    this.ready.set(true);
  }

  private applySession(session: Session | null): void {
    this.session.set(session);
    this.user.set(session?.user ?? null);
    if (session?.user) {
      void this.refreshProfile(session.user.id);
    } else {
      this.profile.set(null);
    }
  }

  async refreshProfile(userId?: string): Promise<Profile | null> {
    const id = userId ?? this.user()?.id;
    if (!id) {
      this.profile.set(null);
      return null;
    }
    const { data, error } = await this.supabase
      .from('profiles')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) {
      console.error('[auth] profile load', error.message);
      return null;
    }
    const profile = data as Profile | null;
    this.profile.set(profile);
    return profile;
  }

  async signUp(username: string, email: string, password: string): Promise<{ error: string | null }> {
    const validation = validateUsername(username);
    if (!validation.ok) {
      return { error: validation.reason };
    }

    const { data: available, error: availError } = await this.supabase.rpc(
      'is_username_available',
      { p_username: username.trim() },
    );
    if (availError) {
      return { error: availError.message };
    }
    if (available === false) {
      return { error: 'ეს სახელი უკვე დაკავებულია' };
    }

    const { error } = await this.supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: { username: username.trim() },
      },
    });

    if (error) {
      return { error: error.message };
    }
    return { error: null };
  }

  async signIn(email: string, password: string): Promise<{ error: string | null }> {
    const { error } = await this.supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    return { error: error?.message ?? null };
  }

  async signOut(): Promise<void> {
    await this.supabase.auth.signOut();
    this.profile.set(null);
  }

  async resetPassword(email: string): Promise<{ error: string | null }> {
    const { error } = await this.supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/login`,
    });
    return { error: error?.message ?? null };
  }

  async updateProfile(patch: { username?: string; avatar_url?: string | null }): Promise<{ error: string | null }> {
    const id = this.user()?.id;
    if (!id) return { error: 'ავტორიზაცია საჭიროა' };

    const updates: Record<string, unknown> = {};
    if (patch.username !== undefined) {
      const validation = validateUsername(patch.username);
      if (!validation.ok) return { error: validation.reason };
      updates['username'] = patch.username.trim();
      updates['username_normalized'] = normalizeUsername(patch.username);
    }
    if (patch.avatar_url !== undefined) {
      updates['avatar_url'] = patch.avatar_url;
    }

    const { error } = await this.supabase.from('profiles').update(updates).eq('id', id);
    if (error) {
      if (error.code === '23505') return { error: 'ეს სახელი უკვე დაკავებულია' };
      return { error: error.message };
    }
    await this.refreshProfile(id);
    return { error: null };
  }

  get client(): SupabaseClient {
    return this.supabase;
  }
}
