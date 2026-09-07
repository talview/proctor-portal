import { supabase } from './supabase';
import { logAudit } from './audit';
import type { User, UserRole } from '@/types';

const ROLE_VALUES: UserRole[] = ['admin', 'vendor', 'coordinator'];

async function buildUserFromSession(authUserId: string, fallbackEmail: string): Promise<User> {
  const { data, error } = await supabase
    .from('users')
    .select('id, username, email, role, created_at, vendors(name)')
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
    name: username.replace(/_/g, ' '),
    email: data.email || fallbackEmail,
    role,
    vendor: vendorName as User['vendor'],
    created_at: data.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export const authService = {
  /**
   * Login with email and password using real Supabase Auth.
   */
  async login(email: string, password: string): Promise<User> {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error || !data.user) {
      throw new Error('Invalid credentials');
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
