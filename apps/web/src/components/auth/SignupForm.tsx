import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { useAuth } from '../../hooks/useAuth';
import { useAuthStore, isFirebaseMode } from '../../store/authStore';

export function SignupForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fbLoading, setFbLoading] = useState<'google' | 'github' | null>(null);
  const { signup } = useAuth();
  const loginWithFirebase = useAuthStore((s) => s.loginWithFirebase);
  const storeError = useAuthStore((s) => s.error);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await signup(email, password, name);
      navigate('/onboarding');
    } catch (err: any) {
      setError(err.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  const handleFirebaseLogin = async (provider: 'google' | 'github') => {
    setFbLoading(provider);
    try {
      await loginWithFirebase(provider);
      navigate('/dashboard');
    } catch {
      // error in store
    } finally {
      setFbLoading(null);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5 w-full max-w-sm">
      <h2 className="font-display text-3xl font-bold uppercase text-nb-text">Create Account</h2>

      {error && (
        <div className="border-3 border-nb-red bg-nb-red/10 p-3 font-mono text-sm text-nb-red font-bold">
          {error}
        </div>
      )}

      {isFirebaseMode && storeError && !error && (
        <div className="border-3 border-nb-red bg-nb-red/10 p-3 font-mono text-sm text-nb-red font-bold">
          {storeError}
        </div>
      )}

      <Input
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Your name"
        required
        minLength={1}
      />
      <Input
        label="Email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="your@email.com"
        required
      />
      <Input
        label="Password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="********"
        required
      />

      <Button type="submit" size="lg" disabled={loading}>
        {loading ? 'CREATING...' : 'CREATE ACCOUNT'}
      </Button>

      <p className="font-mono text-sm text-nb-text">
        Already have an account?{' '}
        <Link to="/login" className="font-bold underline decoration-3 hover:text-nb-pink">
          SIGN IN
        </Link>
      </p>

      {isFirebaseMode && (
        <>
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-nb-border" />
            <span className="font-mono text-xs text-nb-text uppercase">or</span>
            <div className="flex-1 h-px bg-nb-border" />
          </div>
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => handleFirebaseLogin('google')}
              disabled={!!fbLoading}
              className="w-full border-3 border-nb-border bg-nb-surface font-mono font-bold text-sm uppercase py-3 px-4 hover:bg-nb-lime/10 disabled:opacity-50 flex items-center justify-center gap-2 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-nb-lime"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
              {fbLoading === 'google' ? 'SIGNING IN...' : 'CONTINUE WITH GOOGLE'}
            </button>
            <button
              type="button"
              onClick={() => handleFirebaseLogin('github')}
              disabled={!!fbLoading}
              className="w-full border-3 border-nb-border bg-nb-surface font-mono font-bold text-sm uppercase py-3 px-4 hover:bg-nb-lime/10 disabled:opacity-50 flex items-center justify-center gap-2 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-nb-lime"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                aria-hidden="true"
                fill="currentColor"
              >
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
              </svg>
              {fbLoading === 'github' ? 'SIGNING IN...' : 'CONTINUE WITH GITHUB'}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
