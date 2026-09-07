import { describe, it, expect, beforeEach, vi } from 'vitest';
import { authService } from '@/services/auth';
import { supabase } from '@/services/supabase';

const mockedAuth = supabase.auth as unknown as {
  getSession: ReturnType<typeof vi.fn>;
  signInWithPassword: ReturnType<typeof vi.fn>;
  signOut: ReturnType<typeof vi.fn>;
};

function mockProfile(profile: Record<string, unknown> | null) {
  (supabase.from as ReturnType<typeof vi.fn>).mockReturnValueOnce({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: profile, error: profile ? null : { message: 'not found' } }),
  });
}

describe('authService', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  describe('getCurrentUser', () => {
    it('returns null when there is no active Supabase session', async () => {
      mockedAuth.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
      expect(await authService.getCurrentUser()).toBeNull();
    });

    it('returns a User built from the session + profile row when a session exists', async () => {
      mockedAuth.getSession.mockResolvedValueOnce({
        data: { session: { user: { id: 'abc-123', email: 'admin@test.com' } } },
        error: null,
      });
      mockProfile({
        id: 'abc-123',
        username: 'admin',
        email: 'admin@test.com',
        role: 'admin',
        created_at: '2024-01-01T00:00:00Z',
        vendors: null,
      });

      const result = await authService.getCurrentUser();
      expect(result).toMatchObject({
        id: 'abc-123',
        username: 'admin',
        email: 'admin@test.com',
        role: 'admin',
      });
    });

    it('returns null when the session exists but no profile row is found', async () => {
      mockedAuth.getSession.mockResolvedValueOnce({
        data: { session: { user: { id: 'orphan-id', email: 'orphan@test.com' } } },
        error: null,
      });
      mockProfile(null);

      expect(await authService.getCurrentUser()).toBeNull();
    });

    it('falls back to vendor role for an unrecognized role value', async () => {
      mockedAuth.getSession.mockResolvedValueOnce({
        data: { session: { user: { id: 'v-1', email: 'v@test.com' } } },
        error: null,
      });
      mockProfile({
        id: 'v-1',
        username: 'v',
        email: 'v@test.com',
        role: 'something-unexpected',
        created_at: '2024-01-01T00:00:00Z',
        vendors: null,
      });

      const result = await authService.getCurrentUser();
      expect(result?.role).toBe('vendor');
    });
  });

  describe('login', () => {
    it('throws "Invalid credentials" when Supabase rejects the password', async () => {
      mockedAuth.signInWithPassword.mockResolvedValueOnce({
        data: { user: null, session: null },
        error: { message: 'Invalid login credentials' },
      });

      await expect(authService.login('bad@test.com', 'wrong')).rejects.toThrow('Invalid credentials');
    });

    it('returns the User and caches it in localStorage on success', async () => {
      mockedAuth.signInWithPassword.mockResolvedValueOnce({
        data: { user: { id: 'admin-1', email: 'admin@test.com' } },
        error: null,
      });
      mockProfile({
        id: 'admin-1',
        username: 'admin',
        email: 'admin@test.com',
        role: 'admin',
        created_at: '2024-01-01T00:00:00Z',
        vendors: null,
      });

      const user = await authService.login('admin@test.com', 'correct');
      expect(user.email).toBe('admin@test.com');
      expect(JSON.parse(localStorage.getItem('user')!)).toMatchObject({ email: 'admin@test.com' });
    });
  });

  describe('isAuthenticated', () => {
    it('returns false when there is no session', async () => {
      mockedAuth.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
      expect(await authService.isAuthenticated()).toBe(false);
    });
  });

  describe('logout', () => {
    it('clears localStorage and calls supabase signOut, without throwing when no user is logged in', async () => {
      mockedAuth.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
      await expect(authService.logout()).resolves.not.toThrow();
      expect(mockedAuth.signOut).toHaveBeenCalled();
      expect(localStorage.getItem('user')).toBeNull();
    });
  });
});
