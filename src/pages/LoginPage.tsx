import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth';
import talviewIcon from '@/assets/branding/talview-app-icon.png';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { login, error, isLoading } = useAuthStore();
  const navigate = useNavigate();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      // Error is handled by the store
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSubmit(e as any);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-radial from-[#1a2540] via-bg to-bg">
      <div className="bg-surface border border-border rounded-2xl p-12 w-full max-w-md shadow-2xl">
        {/* Logo */}
        <div className="text-center mb-8">
          <img src={talviewIcon} alt="Talview" className="w-14 h-14 rounded-xl mx-auto mb-3 shadow-md" />
          <div className="text-[26px] font-extrabold tracking-tight text-text mb-1.5">
            Talview
          </div>
          <div className="text-[13px] text-text2 font-medium">
            Proctor Portal
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit}>
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

          <div className="mb-4">
            <label className="block text-xs font-semibold text-text2 uppercase tracking-wide mb-1.5">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder="Enter your password"
              autoComplete="current-password"
              className="w-full bg-surface2 border border-border rounded-md px-3.5 py-2.5 text-sm text-text outline-none focus:border-accent transition-colors"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-accent hover:bg-accent/90 text-white font-semibold py-2.5 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? 'Signing in...' : 'Sign In'}
          </button>

          {error && (
            <p className="text-danger text-[13px] text-center mt-3 min-h-[20px]">
              {error}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
