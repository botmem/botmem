import { useState, useRef, useCallback, useSyncExternalStore } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { Logo } from '../components/ui/Logo';
import { useAuthStore, isFirebaseMode } from '../store/authStore';

const SCOPE_LABELS: Record<string, string> = {
  read: 'Read your memories',
  write: 'Write/modify memories',
  search: 'Search your memories',
  contacts: 'Access your contacts',
};

function createClientNameStore() {
  let name = '';
  let loadedFor = '';
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  return {
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getSnapshot: () => name,
    load(clientId: string) {
      if (!clientId || clientId === loadedFor) return;
      loadedFor = clientId;
      fetch(`/oauth/client-info?client_id=${encodeURIComponent(clientId)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d?.client_name) {
            name = d.client_name;
            notify();
          }
        })
        .catch(() => {});
    },
  };
}

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
  const [fbLoading, setFbLoading] = useState<'google' | 'github' | null>(null);

  const user = useAuthStore((s) => s.user);
  const accessToken = useAuthStore((s) => s.accessToken);
  const loginWithFirebase = useAuthStore((s) => s.loginWithFirebase);
  const storeError = useAuthStore((s) => s.error);

  // Derive step from auth state (replaces useEffect)
  const derivedStep = user && accessToken && step === 'login' ? 'consent' : step;

  // Fetch client name via external store (replaces useEffect + fetch)
  const storeRef = useRef<ReturnType<typeof createClientNameStore>>(null);
  if (!storeRef.current) storeRef.current = createClientNameStore();
  storeRef.current.load(clientId);
  const subscribe = useCallback((cb: () => void) => storeRef.current!.subscribe(cb), []);
  const clientName = useSyncExternalStore(subscribe, () => storeRef.current!.getSnapshot());

  const scopes = scope.split(/[\s,]+/).filter(Boolean);
  const missingParams = !clientId || !redirectUri;

  async function handleFirebaseLogin(provider: 'google' | 'github') {
    setFbLoading(provider);
    setError('');
    try {
      await loginWithFirebase(provider);
      setStep('consent');
    } catch {
      // error already set in store
    } finally {
      setFbLoading(null);
    }
  }

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
        setTimeout(() => {
          window.location.href = data.redirect_uri;
        }, 500);
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
          {derivedStep === 'login' && (
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

              {isFirebaseMode && storeError && !error && (
                <div className="border-3 border-nb-red bg-nb-red/10 p-3 mt-4 font-mono text-sm text-nb-red font-bold">
                  {storeError}
                </div>
              )}
            </div>
          )}

          {/* Logged in indicator */}
          {(derivedStep === 'consent' || derivedStep === 'recovery') && user && (
            <div className="border-3 border-nb-border bg-nb-surface p-4 shadow-nb">
              <div className="font-mono text-sm text-nb-muted">Signed in as</div>
              <div className="font-display font-bold text-nb-text">{user.email || 'User'}</div>
            </div>
          )}

          {/* Recovery key step — only shown when server says DEK is cold */}
          {derivedStep === 'recovery' && (
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

          {/* Consent section */}
          {derivedStep === 'consent' && (
            <div className="border-3 border-nb-border bg-nb-surface p-6 shadow-nb">
              <h2 className="font-display text-xl font-bold uppercase text-nb-text mb-3">
                Authorize Access?
              </h2>
              <p className="font-mono text-sm text-nb-text mb-4">
                <span className="font-bold text-nb-pink">{clientName || clientId}</span> wants to
                access your memories.
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
          {derivedStep === 'done' && (
            <div className="border-3 border-nb-lime bg-nb-lime/10 p-6 shadow-nb text-center">
              <div className="text-nb-lime text-4xl font-bold mb-3">&#10003;</div>
              <h2 className="font-display text-xl font-bold uppercase text-nb-text mb-2">
                Authorized
              </h2>
              <p className="font-mono text-sm text-nb-muted">Redirecting you now...</p>
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
