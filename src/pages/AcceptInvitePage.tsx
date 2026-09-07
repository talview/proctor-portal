import { useEffect, useState, FormEvent } from 'react';
import { supabase } from '@/services/supabase';

// Reached when a Supabase invite link lands here with the session tokens in the URL
// fragment (#access_token=...&type=invite). Supabase's own hosted flow only issues the
// session -- nothing sets an actual password, so without this page every invited user
// would be stuck: logged in for one hour, then permanently unable to sign back in.
export default function AcceptInvitePage() {
  const [status, setStatus] = useState<'loading' | 'form' | 'saving' | 'success' | 'error'>('loading');
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  useEffect(() => {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    const params = new URLSearchParams(hash);
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    const type = params.get('type');

    if (!accessToken || !refreshToken || type !== 'invite') {
      setStatus('error');
      setError('This invite link is invalid, expired, or has already been used.');
      return;
    }

    supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken }).then(({ error: sessionError }) => {
      // Clear the tokens from the address bar immediately either way -- they should
      // never sit visible/bookmarkable in the browser history.
      window.history.replaceState(null, '', window.location.pathname);
      if (sessionError) {
        setStatus('error');
        setError(sessionError.message);
        return;
      }
      setStatus('form');
    });
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setError('');
    setStatus('saving');
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError(updateError.message);
      setStatus('form');
      return;
    }
    setStatus('success');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-radial from-[#1a2540] via-bg to-bg">
      <div className="bg-surface border border-border rounded-2xl p-12 w-full max-w-md shadow-2xl">
        <div className="text-center mb-8">
          <div className="text-[26px] font-extrabold tracking-tight text-text mb-1.5">Talview</div>
          <div className="text-[13px] text-text2 font-medium">Proctor Portal</div>
        </div>

        {status === 'loading' && (
          <p className="text-center text-sm text-text2">Verifying your invite...</p>
        )}

        {status === 'error' && (
          <div className="text-center">
            <p className="text-danger text-[13px] mb-4">{error}</p>
            <a href="/login" className="text-accent text-sm font-semibold">Go to Sign In</a>
          </div>
        )}

        {status === 'success' && (
          <div className="text-center">
            <p className="text-success text-sm font-semibold mb-4">Password set successfully.</p>
            <a href="/" className="inline-block w-full bg-accent hover:bg-accent/90 text-white font-semibold py-2.5 rounded-md transition-colors">
              Continue to Proctor Portal
            </a>
          </div>
        )}

        {(status === 'form' || status === 'saving') && (
          <form onSubmit={handleSubmit}>
            <p className="text-sm text-text2 mb-5">Set a password to finish accepting your invite.</p>

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
              className="w-full bg-accent hover:bg-accent/90 text-white font-semibold py-2.5 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {status === 'saving' ? 'Saving...' : 'Set Password & Continue'}
            </button>

            {error && (
              <p className="text-danger text-[13px] text-center mt-3 min-h-[20px]">{error}</p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
