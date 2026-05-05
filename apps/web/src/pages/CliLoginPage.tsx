import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { Logo } from '../components/ui/Logo';
import { useAuthStore } from '../store/authStore';

export default function CliLoginPage() {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('session_id') || '';

  const user = useAuthStore((s) => s.user);
  const accessToken = useAuthStore((s) => s.accessToken);
  const isLoadingAuth = useAuthStore((s) => s.isLoading);
  const logout = useAuthStore((s) => s.logout);

  const [recoveryKey, setRecoveryKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'authenticating' | 'confirm' | 'recovery' | 'done'>(
    'authenticating',
  );

  const returnPath = `/cli-login?session_id=${encodeURIComponent(sessionId)}`;
  const loginPath = `/login?redirect=${encodeURIComponent(returnPath)}`;

  useEffect(() => {
    if (user && accessToken) {
      setStep('confirm');
      return;
    }
    if (!isLoadingAuth && sessionId) {
      window.location.replace(loginPath);
    }
  }, [accessToken, isLoadingAuth, loginPath, sessionId, user]);

  if (!sessionId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-nb-bg p-6">
        <div className="w-full max-w-md">
          <Logo variant="full" height={32} className="mx-auto mb-8" />
          <div className="border-3 border-nb-border bg-nb-surface p-6 shadow-nb">
            <div className="border-3 border-nb-red bg-nb-red/10 p-3 font-mono text-sm text-nb-red font-bold">
              Invalid CLI login request. Missing session ID.
            </div>
          </div>
        </div>
      </div>
    );
  }

  async function doApprove(opts?: { recoveryKey?: string; useExistingSession?: boolean }) {
    setLoading(true);
    setError('');
    try {
      if (!accessToken) {
        window.location.replace(loginPath);
        return;
      }

      const res = await fetch('/api/user-auth/cli/approve-with-token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          sessionId,
          ...(opts?.recoveryKey ? { recoveryKey: opts.recoveryKey } : {}),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ message: `Error ${res.status}` }));
        if (res.status === 403 && !opts?.recoveryKey) {
          setStep('recovery');
          setLoading(false);
          return;
        }
        if (res.status === 401) {
          window.location.replace(loginPath);
          return;
        }
        setError(data.message || 'Authorization failed');
        return;
      }

      const data = await res.json();
      if (data.redirectUri) {
        setStep('done');
        setTimeout(() => {
          window.location.href = data.redirectUri;
        }, 500);
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function handleConfirm() {
    doApprove({ useExistingSession: true });
  }

  function handleRecoverySubmit(e: React.FormEvent) {
    e.preventDefault();
    doApprove({ useExistingSession: true, recoveryKey });
  }

  function handleDifferentAccount() {
    logout().finally(() => {
      window.location.href = loginPath;
    });
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-nb-bg p-6">
      <div className="w-full max-w-md">
        <Logo variant="full" height={32} className="mx-auto mb-8" />

        <div className="flex flex-col gap-5">
          {/* Already logged in — just confirm */}
          {step === 'confirm' && user && (
            <div className="border-3 border-nb-border bg-nb-surface p-6 shadow-nb">
              <h2 className="font-display text-xl font-bold uppercase text-nb-text mb-1">
                Authorize CLI
              </h2>
              <p className="font-mono text-xs text-nb-muted mb-4">
                Authorize the Botmem CLI to access your account.
              </p>
              <div className="border-3 border-nb-border bg-nb-bg/50 p-3 mb-4">
                <div className="font-mono text-xs text-nb-muted">Signed in as</div>
                <div className="font-display font-bold text-nb-text">{user.email || 'User'}</div>
              </div>
              <div className="flex gap-3">
                <Button
                  variant="secondary"
                  size="md"
                  onClick={handleDifferentAccount}
                  disabled={loading}
                  className="flex-1"
                >
                  USE DIFFERENT ACCOUNT
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  onClick={handleConfirm}
                  disabled={loading}
                  className="flex-1"
                >
                  {loading ? 'AUTHORIZING...' : 'AUTHORIZE'}
                </Button>
              </div>
            </div>
          )}

          {step === 'authenticating' && (
            <div className="border-3 border-nb-border bg-nb-surface p-6 shadow-nb">
              <h2 className="font-display text-xl font-bold uppercase text-nb-text mb-1">
                CLI Login
              </h2>
              <p className="font-mono text-xs text-nb-muted mb-4">
                Opening Botmem login to authorize the CLI.
              </p>
            </div>
          )}

          {/* Recovery key step */}
          {step === 'recovery' && (
            <form onSubmit={handleRecoverySubmit} className="flex flex-col gap-5">
              <div className="border-3 border-nb-border bg-nb-surface p-6 shadow-nb">
                <h2 className="font-display text-xl font-bold uppercase text-nb-text mb-1">
                  Recovery Key Required
                </h2>
                <p className="font-mono text-xs text-nb-muted mb-4">
                  Your encryption key is not cached. Enter your recovery key to continue.
                </p>
                <Input
                  label="Recovery Key"
                  type="text"
                  data-ph-mask
                  value={recoveryKey}
                  onChange={(e) => setRecoveryKey(e.target.value)}
                  placeholder="Your 32-byte base64 recovery key"
                  required
                  className="font-mono text-sm"
                />
              </div>
              <Button type="submit" size="md" disabled={loading || !recoveryKey}>
                {loading ? 'AUTHORIZING...' : 'UNLOCK & AUTHORIZE'}
              </Button>
            </form>
          )}

          {/* Success */}
          {step === 'done' && (
            <div className="border-3 border-nb-lime bg-nb-lime/10 p-6 shadow-nb text-center">
              <div className="text-nb-lime text-4xl font-bold mb-3">&#10003;</div>
              <h2 className="font-display text-xl font-bold uppercase text-nb-text mb-2">
                CLI Authorized
              </h2>
              <p className="font-mono text-sm text-nb-muted">
                You can close this window and return to your terminal.
              </p>
            </div>
          )}

          {error && (
            <div className="border-3 border-nb-red bg-nb-red/10 p-3 font-mono text-sm text-nb-red font-bold">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
