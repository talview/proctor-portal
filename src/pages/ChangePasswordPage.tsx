import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/services/supabase';
import { useAuthStore } from '@/stores/auth';

/** Two entry points, one page:
 *  - Forced: ProtectedRoute redirects here whenever user.mustChangePassword is
 *    set (an admin-issued temp password, 'Set password directly' mode) --
 *    nothing else in the app is reachable until it's cleared, so there's no
 *    current-password check (the "current" password is the temp one the
 *    admin just handed them) and no way to back out.
 *  - Voluntary: reached via the sidebar's "Change Password" link on an
 *    already-established account -- asks for the current password first,
 *    since here a hijacked-but-unlocked session taking over the account
 *    silently is a real risk an admin-forced first change doesn't share.
 */
export default function ChangePasswordPage() {
  const navigate = useNavigate();
  const { user, initialize } = useAuthStore();
  const forced = Boolean(user?.mustChangePassword);

  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [status, setStatus] = useState<'form' | 'saving' | 'success'>('form');
  const [error, setError] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!forced && !currentPassword) {
      setError('Enter your current password.');
      return;
    }
    if (password.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setError('');
    setStatus('saving');

    if (!forced && user) {
      const { error: reauthError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: currentPassword,
      });
      if (reauthError) {
        setError('Current password is incorrect.');
        setStatus('form');
        return;
      }
    }

    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError(updateError.message);
      setStatus('form');
      return;
    }

    const { error: rpcError } = await supabase.rpc('mark_password_changed');
    if (rpcError) {
      setError(rpcError.message);
      setStatus('form');
      return;
    }

    // Refresh the store's user so mustChangePassword flips to false --
    // otherwise ProtectedRoute would just bounce straight back here.
    await initialize();
    setStatus('success');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <div className="bg-surface border border-border rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
        <div className="h-1.5 bg-gradient-to-r from-accent to-accent5" />
        <div className="p-12">
        <div className="text-center mb-8">
          <div className="text-[26px] font-extrabold tracking-tight text-text mb-1.5">Talview</div>
          <div className="text-[13px] text-text2 font-medium">Proctor Portal</div>
        </div>

        {status === 'success' && (
          <div className="text-center">
            <p className="text-success text-sm font-semibold mb-4">Password updated successfully.</p>
            <button
              onClick={() => navigate('/', { replace: true })}
              className="inline-block w-full bg-gradient-to-r from-accent to-accent5 hover:brightness-110 text-white font-semibold py-2.5 rounded-md transition-[filter]"
            >
              Continue to Proctor Portal
            </button>
          </div>
        )}

        {status !== 'success' && (
          <form onSubmit={handleSubmit}>
            <p className="text-sm text-text2 mb-5">
              {forced
                ? "You're signing in with a temporary password. Set your own before continuing."
                : 'Set a new password for your account.'}
            </p>

            {!forced && (
              <div className="mb-4">
                <label className="block text-xs font-semibold text-text2 uppercase tracking-wide mb-1.5">
                  Current Password
                </label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  autoComplete="current-password"
                  className="w-full bg-surface2 border border-border rounded-md px-3.5 py-2.5 text-sm text-text outline-none focus:border-accent transition-colors"
                />
              </div>
            )}

            <div className="mb-4">
              <label className="block text-xs font-semibold text-text2 uppercase tracking-wide mb-1.5">
                New Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoComplete="new-password"
                className="w-full bg-surface2 border border-border rounded-md px-3.5 py-2.5 text-sm text-text outline-none focus:border-accent transition-colors"
              />
            </div>

            <div className="mb-4">
              <label className="block text-xs font-semibold text-text2 uppercase tracking-wide mb-1.5">
                Confirm Password
              </label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Re-enter password"
                autoComplete="new-password"
                className="w-full bg-surface2 border border-border rounded-md px-3.5 py-2.5 text-sm text-text outline-none focus:border-accent transition-colors"
              />
            </div>

            <button
              type="submit"
              disabled={status === 'saving'}
              className="w-full bg-gradient-to-r from-accent to-accent5 hover:brightness-110 text-white font-semibold py-2.5 rounded-md transition-[filter] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {status === 'saving' ? 'Saving...' : 'Set Password & Continue'}
            </button>

            {!forced && (
              <button
                type="button"
                onClick={() => navigate(-1)}
                className="w-full text-text3 hover:text-text2 text-[13px] font-medium py-2.5 mt-1 transition-colors"
              >
                Cancel
              </button>
            )}

            {error && (
              <p className="text-danger text-[13px] text-center mt-3 min-h-[20px]">{error}</p>
            )}
          </form>
        )}
        </div>
      </div>
    </div>
  );
}
