import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { Logo } from '../components/ui/Logo';
import { ThemeToggle } from '../components/ui/ThemeToggle';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/user-auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        throw new Error('Something went wrong. Please try again.');
      }
      setSubmitted(true);
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

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
              FORGOT PASSWORD
            </h2>

            {submitted ? (
              <div className="flex flex-col gap-5">
                <div className="border-3 border-nb-lime bg-nb-lime/10 p-4 font-mono text-sm text-nb-text font-bold">
                  If that email exists, we sent a reset link. Check your inbox (or server console in
                  dev mode).
                </div>
                <Link
                  to="/login"
                  className="font-mono text-sm font-bold underline decoration-3 hover:text-nb-pink text-nb-text"
                >
                  Back to login
                </Link>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="flex flex-col gap-5">
                {error && (
                  <div className="border-3 border-nb-red bg-nb-red/10 p-3 font-mono text-sm text-nb-red font-bold">
                    {error}
                  </div>
                )}

                <p className="font-mono text-sm text-nb-text">
                  Enter your email address and we will send you a link to reset your password.
                </p>

                <Input
                  label="Email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  required
                />

                <Button type="submit" size="lg" disabled={loading}>
                  {loading ? 'SENDING...' : 'SEND RESET LINK'}
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
              RESET
              <br />
              YOUR
              <br />
              <span className="text-nb-lime">ACCESS.</span>
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
