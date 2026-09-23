import { useState, FormEvent } from 'react';
import { invokeEdgeFunction } from '@/services/supabase';

// Deliberately shows the exact same success message whether or not the
// entered email matches a real account -- request-password-reset/index.ts
// always responds the same way too, so this page can't be used (or misused)
// to check which emails have accounts here.
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'form' | 'sending' | 'sent'>('form');
  const [error, setError] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      setError('Enter your email address.');
      return;
    }
    setError('');
    setStatus('sending');
    try {
      await invokeEdgeFunction('request-password-reset', { email: email.trim() });
    } catch {
      // The edge function itself never returns an error response -- this only
      // catches a genuine network failure, which still shows the same
      // generic confirmation rather than a scary error.
    }
    setStatus('sent');
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

        {status === 'sent' ? (
          <div className="text-center">
            <p className="text-sm text-text2 mb-4">
              If an account exists for <span className="text-text font-semibold">{email}</span>, we've sent a link to
              reset your password. Check your inbox.
            </p>
            <a href="/login" className="text-accent text-sm font-semibold">Back to Sign In</a>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <p className="text-sm text-text2 mb-5">
              Enter your account email and we'll send you a link to reset your password.
            </p>

            <div className="mb-4">
              <label className="block text-xs font-semibold text-text2 uppercase tracking-wide mb-1.5">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Enter your email"
                autoComplete="email"
                className="w-full bg-surface2 border border-border rounded-md px-3.5 py-2.5 text-sm text-text outline-none focus:border-accent transition-colors"
              />
            </div>

            <button
              type="submit"
              disabled={status === 'sending'}
              className="w-full bg-gradient-to-r from-accent to-accent5 hover:brightness-110 text-white font-semibold py-2.5 rounded-md transition-[filter] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {status === 'sending' ? 'Sending...' : 'Send Reset Link'}
            </button>

            <a
              href="/login"
              className="block text-center text-text3 hover:text-text2 text-[13px] font-medium py-2.5 mt-1 transition-colors"
            >
              Back to Sign In
            </a>

            {error && (
              <p className="text-danger text-[13px] text-center mt-1 min-h-[20px]">{error}</p>
            )}
          </form>
        )}
        </div>
      </div>
    </div>
  );
}
