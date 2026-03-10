import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { Logo } from '../components/ui/Logo';
import { useAuthStore } from '../store/authStore';

const SCOPE_LABELS: Record<string, string> = {
  read: 'Read your memories',
  write: 'Write/modify memories',
  search: 'Search your memories',
  contacts: 'Access your contacts',
};

export default function OAuthConsentPage() {
  const [searchParams] = useSearchParams();
  const clientId = searchParams.get('client_id') || '';
  const scope = searchParams.get('scope') || 'read write';
  const state = searchParams.get('state') || '';
  const codeChallenge = searchParams.get('code_challenge') || '';
  const codeChallengeMethod = searchParams.get('code_challenge_method') || 'S256';
  const redirectUri = searchParams.get('redirect_uri') || '';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'login' | 'consent' | 'recovery' | 'done'>('login');
  const [clientName, setClientName] = useState('');

  const user = useAuthStore((s) => s.user);
  const accessToken = useAuthStore((s) => s.accessToken);

  // If already logged in, skip to consent step
  useEffect(() => {
    if (user && accessToken) {
      setStep('consent');
    }
  }, [user, accessToken]);

  // Fetch client display name
  useEffect(() => {
    if (!clientId) return;
    fetch(`/oauth/client-info?client_id=${encodeURIComponent(clientId)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.client_name) setClientName(d.client_name); })
      .catch(() => {});
  }, [clientId]);

  const scopes = scope.split(/[\s,]+/).filter(Boolean);
  const missingParams = !clientId || !redirectUri;

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/user-auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: `Error ${res.status}` }));
        setError(body.message || 'Login failed');
        return;
      }
      const data = await res.json();
      useAuthStore.setState({
        user: data.user,
        accessToken: data.accessToken,
      });
      setStep('consent');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function doAuthorize(withRecoveryKey?: string) {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/oauth/authorize/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({
          ...(email ? { email } : {}),
          ...(password ? { password } : {}),
          ...(withRecoveryKey ? { recoveryKey: withRecoveryKey } : {}),
          clientId,
          scope,
          state,
          codeChallenge,
          codeChallengeMethod,
          redirectUri,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ message: 'Authorization failed' }));
        // If server says recovery key is needed, show that step
        if (res.status === 403 && !withRecoveryKey) {
          setStep('recovery');
          setLoading(false);
          return;
        }
        setError(data.message || 'Authorization failed');
        return;
      }

      const data = await res.json();
      if (data.redirect_uri) {
        setStep('done');
        // Small delay so user sees the success state before redirect
        setTimeout(() => { window.location.href = data.redirect_uri; }, 500);
      } else {
        // No redirect (e.g. headless flow) — show done message
        setStep('done');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function handleAuthorize() {
    doAuthorize();
  }

  function handleAuthorizeWithKey(e: React.FormEvent) {
    e.preventDefault();
    doAuthorize(recoveryKey);
  }

  function handleDeny() {
    if (redirectUri) {
      const separator = redirectUri.includes('?') ? '&' : '?';
      window.location.href = `${redirectUri}${separator}error=access_denied&state=${encodeURIComponent(state)}`;
    }
  }

  if (missingParams) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-nb-bg p-6">
        <div className="w-full max-w-md">
          <Logo variant="full" height={32} className="mx-auto mb-8" />
          <div className="border-3 border-nb-border bg-nb-surface p-6 shadow-nb">
            <div className="border-3 border-nb-red bg-nb-red/10 p-3 font-mono text-sm text-nb-red font-bold">
              Invalid authorization request. Missing required parameters (client_id, redirect_uri).
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-nb-bg p-6">
      <div className="w-full max-w-md">
        <Logo variant="full" height={32} className="mx-auto mb-8" />

        <div className="flex flex-col gap-5">
          {/* Login section */}
          {step === 'login' && (
            <div className="border-3 border-nb-border bg-nb-surface p-6 shadow-nb">
              <h2 className="font-display text-xl font-bold uppercase text-nb-text mb-4">
                Sign In
              </h2>
              <form onSubmit={handleLogin} className="flex flex-col gap-4">
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
                <Button type="submit" size="md" disabled={loading}>
                  {loading ? 'SIGNING IN...' : 'SIGN IN'}
                </Button>
              </form>
            </div>
          )}

          {/* Logged in indicator */}
          {(step === 'consent' || step === 'recovery') && user && (
            <div className="border-3 border-nb-border bg-nb-surface p-4 shadow-nb">
              <div className="font-mono text-sm text-nb-muted">Signed in as</div>
              <div className="font-display font-bold text-nb-text">
                {user.email || 'User'}
              </div>
            </div>
          )}

          {/* Recovery key step — only shown when server says DEK is cold */}
          {step === 'recovery' && (
            <form onSubmit={handleAuthorizeWithKey} className="flex flex-col gap-5">
              <div className="border-3 border-nb-border bg-nb-surface p-6 shadow-nb">
                <h2 className="font-display text-xl font-bold uppercase text-nb-text mb-1">
                  Recovery Key Required
                </h2>
                <p className="font-mono text-xs text-nb-muted mb-4">
                  Your encryption key is not cached. Enter your recovery key to unlock access.
                </p>
                <Input
                  label="Recovery Key"
                  type="text"
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

          {/* Consent section */}
          {step === 'consent' && (
            <div className="border-3 border-nb-border bg-nb-surface p-6 shadow-nb">
              <h2 className="font-display text-xl font-bold uppercase text-nb-text mb-3">
                Authorize Access?
              </h2>
              <p className="font-mono text-sm text-nb-text mb-4">
                <span className="font-bold text-nb-pink">{clientName || clientId}</span>{' '}
                wants to access your memories.
              </p>

              <div className="mb-5">
                <div className="font-display text-xs font-bold uppercase tracking-wider text-nb-muted mb-2">
                  Permissions requested
                </div>
                <ul className="flex flex-col gap-1.5">
                  {scopes.map((s) => (
                    <li key={s} className="font-mono text-sm text-nb-text flex items-center gap-2">
                      <span className="text-nb-lime font-bold">&#10003;</span>
                      {SCOPE_LABELS[s] || s}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex gap-3">
                <Button
                  variant="secondary"
                  size="md"
                  onClick={handleDeny}
                  disabled={loading}
                  className="flex-1"
                >
                  Deny
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  onClick={handleAuthorize}
                  disabled={loading}
                  className="flex-1"
                >
                  {loading ? 'AUTHORIZING...' : 'AUTHORIZE'}
                </Button>
              </div>
            </div>
          )}

          {/* Done — authorization complete */}
          {step === 'done' && (
            <div className="border-3 border-nb-lime bg-nb-lime/10 p-6 shadow-nb text-center">
              <div className="text-nb-lime text-4xl font-bold mb-3">&#10003;</div>
              <h2 className="font-display text-xl font-bold uppercase text-nb-text mb-2">
                Authorized
              </h2>
              <p className="font-mono text-sm text-nb-muted">
                You can close this tab and return to your app.
              </p>
            </div>
          )}

          {/* Error display */}
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
