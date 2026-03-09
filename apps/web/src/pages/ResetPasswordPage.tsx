import { useState, useEffect } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { Logo } from '../components/ui/Logo';
import { ThemeToggle } from '../components/ui/ThemeToggle';

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [token] = useState(() => searchParams.get('token') || '');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  // Clear token from URL after reading it
  useEffect(() => {
    if (token) {
      window.history.replaceState({}, '', '/reset-password');
    }
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/user-auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: 'Reset failed' }));
        throw new Error(body.message || 'Reset failed');
      }

      setSuccess(true);
      setTimeout(() => navigate('/login'), 3000);
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <>
        {/* Mobile top bar */}
        <div className="md:hidden flex items-center justify-between px-4 py-3 border-b-4 border-nb-border bg-nb-surface">
          <Logo variant="full" height={24} />
          <ThemeToggle />
        </div>
        <div className="min-h-screen flex">
          <div className="flex-1 flex items-center justify-center p-8 bg-nb-surface">
            <div className="w-full max-w-sm text-center">
              <h2 className="font-display text-3xl font-bold uppercase text-nb-text mb-4">
                INVALID LINK
              </h2>
              <p className="font-mono text-sm text-nb-text mb-6">
                This reset link is invalid or has already been used.
              </p>
              <Link
                to="/forgot-password"
                className="font-mono text-sm font-bold underline decoration-3 hover:text-nb-pink text-nb-text"
              >
                Request a new reset link
              </Link>
            </div>
          </div>
          <div className="flex-1 bg-nb-bg text-nb-text flex items-center justify-center p-8 border-l-4 border-nb-border">
            <div>
              <h1 className="font-display text-7xl font-bold leading-tight">
                NEW
                <br />
                <span className="text-nb-lime">PASSWORD.</span>
                <br />
                NEW
                <br />
                START.
              </h1>
              <div className="mt-6 w-24 h-2 bg-nb-pink" />
              <div className="mt-8">
                <Logo variant="full" height={24} />
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {/* Mobile top bar — matches Login/Signup pattern */}
      <div className="md:hidden flex items-center justify-between px-4 py-3 border-b-4 border-nb-border bg-nb-surface">
        <Logo variant="full" height={24} />
        <ThemeToggle />
      </div>
      <div className="min-h-screen flex">
        <div className="flex-1 flex items-center justify-center p-8 bg-nb-surface">
          <div className="w-full max-w-sm">
            <h2 className="font-display text-3xl font-bold uppercase text-nb-text mb-6">
              RESET PASSWORD
            </h2>

            {success ? (
              <div className="flex flex-col gap-5">
                <div className="border-3 border-nb-lime bg-nb-lime/10 p-4 font-mono text-sm text-nb-text font-bold">
                  Password reset successful! Redirecting to login...
                </div>
                <Link
                  to="/login"
                  className="font-mono text-sm font-bold underline decoration-3 hover:text-nb-pink text-nb-text"
                >
                  Go to login now
                </Link>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="flex flex-col gap-5">
                {error && (
                  <div className="border-3 border-nb-red bg-nb-red/10 p-3 font-mono text-sm text-nb-red font-bold">
                    {error}
                  </div>
                )}

                <Input
                  label="New Password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="********"
                  required
                />
                <Input
                  label="Confirm Password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="********"
                  required
                />

                <Button type="submit" size="lg" disabled={loading}>
                  {loading ? 'RESETTING...' : 'RESET PASSWORD'}
                </Button>

                <Link
                  to="/login"
                  className="font-mono text-sm font-bold underline decoration-3 hover:text-nb-pink text-nb-text"
                >
                  Back to login
                </Link>
              </form>
            )}
          </div>
        </div>
        <div className="flex-1 bg-nb-bg text-nb-text flex items-center justify-center p-8 border-l-4 border-nb-border">
          <div>
            <h1 className="font-display text-7xl font-bold leading-tight">
              NEW
              <br />
              <span className="text-nb-lime">PASSWORD.</span>
              <br />
              NEW
              <br />
              START.
            </h1>
            <div className="mt-6 w-24 h-2 bg-nb-pink" />
            <div className="mt-8">
              <Logo variant="full" height={24} />
              <div className="mt-4">
                <ThemeToggle />
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
