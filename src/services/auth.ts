import { supabase } from './supabase';
import { logAudit } from './audit';
import type { User, UserRole } from '@/types';

const ROLE_VALUES: UserRole[] = ['admin', 'vendor', 'coordinator'];

async function buildUserFromSession(authUserId: string, fallbackEmail: string): Promise<User> {
  const { data, error } = await supabase
    .from('users')
    .select('id, username, email, name, role, created_at, must_change_password, vendors(name)')
    .eq('id', authUserId)
    .single();

  if (error || !data) {
    throw new Error('No profile found for this account. Ask an admin to set one up.');
  }

  const role = ROLE_VALUES.includes(data.role as UserRole) ? (data.role as UserRole) : 'vendor';
  const vendorName = (data as unknown as { vendors: { name: string } | null }).vendors?.name;
  const username = data.username || fallbackEmail.split('@')[0];

  return {
    id: data.id,
    username,
    // Real display name (set on the Users admin page) when there is one --
    // falls back to a cosmetic transform of the username for any account
    // created before this field existed.
    name: (data as { name?: string | null }).name || username.replace(/_/g, ' '),
    email: data.email || fallbackEmail,
    role,
    vendor: vendorName as User['vendor'],
    created_at: data.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    mustChangePassword: Boolean((data as { must_change_password?: boolean }).must_change_password),
  };
}

export const authService = {
  /**
   * Login with email and password using real Supabase Auth.
   *
   * Adds an application-layer lockout deterrent around the real sign-in call:
   * check_login_lock/record_failed_login/reset_failed_login are anon-callable
   * RPCs (see migration 0077) keyed by email, since there's no session yet at
   * this point. This protects the app's own login form against repeated
   * guessing -- it does NOT stop someone calling Supabase's Auth REST endpoint
   * directly instead of going through this app, which is a platform-level
   * concern outside what app code can enforce. RPC failures here (an infra
   * hiccup, not a real lock) fail open rather than blocking a legitimate login.
   */
  async login(email: string, password: string): Promise<User> {
    let lockRow: { locked: boolean; locked_until: string | null } | undefined;
    try {
      const { data } = await supabase.rpc('check_login_lock', { p_email: email });
      lockRow = Array.isArray(data) ? data[0] : undefined;
    } catch {
      // best-effort -- proceed to the real sign-in attempt on an RPC hiccup
    }
    if (lockRow?.locked && lockRow.locked_until) {
      const minutes = Math.max(1, Math.ceil((new Date(lockRow.locked_until).getTime() - Date.now()) / 60000));
      throw new Error(`Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error || !data.user) {
      let hint = '';
      try {
        const { data: attempts } = await supabase.rpc('record_failed_login', { p_email: email });
        if (typeof attempts === 'number') {
          const remaining = Math.max(0, 5 - attempts);
          hint = remaining > 0
            ? ` (${remaining} attempt${remaining === 1 ? '' : 's'} remaining before your account is temporarily locked)`
            : ' Your account has been temporarily locked for 15 minutes due to repeated failed attempts.';
        }
      } catch {
        // best-effort -- an infra hiccup here shouldn't change the login error shown
      }
      throw new Error('Invalid credentials.' + hint);
    }

    // Awaited, not fire-and-forget -- a later failed attempt's
    // record_failed_login must increment from a genuinely-reset 0, not race
    // against this still being in flight and increment from a stale count.
    try {
      await supabase.rpc('reset_failed_login', { p_email: email });
    } catch {
      // best-effort -- an infra hiccup here shouldn't block a successful login
    }

    const user = await buildUserFromSession(data.user.id, data.user.email || email);

    localStorage.setItem('user', JSON.stringify(user));
    void logAudit({
      action: 'Login',
      target: user.username,
      detail: `Signed in as ${user.role}${user.vendor ? ` · ${user.vendor}` : ''}`,
      user: user.email,
    });

    return user;
  },

  /**
   * Logout current user
   */
  async logout(): Promise<void> {
    const current = await this.getCurrentUser();
    if (current) {
      void logAudit({
        action: 'Logout',
        target: current.username,
        detail: `Signed out by ${current.email}`,
        user: current.email,
      });
    }
    localStorage.removeItem('user');
    await supabase.auth.signOut();
  },

  /**
   * Get current logged-in user from the real Supabase Auth session (not localStorage --
   * that's now just a display cache, the session itself is managed by the SDK).
   */
  async getCurrentUser(): Promise<User | null> {
    const { data } = await supabase.auth.getSession();
    const sessionUser = data.session?.user;
    if (!sessionUser) {
      localStorage.removeItem('user');
      return null;
    }

    try {
      const user = await buildUserFromSession(sessionUser.id, sessionUser.email || '');
      localStorage.setItem('user', JSON.stringify(user));
      return user;
    } catch {
      return null;
    }
  },

  /**
   * Check if user is authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    return (await this.getCurrentUser()) !== null;
  },
};
