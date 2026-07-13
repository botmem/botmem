import { useState, type FormEvent } from 'react';
import type { BotmemWebClient } from './data-client.js';
import { ThemeToggle } from './ThemeToggle.js';

interface LoginPageProps {
  readonly client: BotmemWebClient;
  readonly initialError?: string;
}

type SubmitState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'sending' }
  | { readonly phase: 'sent' }
  | { readonly phase: 'error'; readonly message: string };

export function LoginPage({ client, initialError }: LoginPageProps) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<SubmitState>(
    initialError ? { phase: 'error', message: initialError } : { phase: 'idle' },
  );

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setState({ phase: 'sending' });
    try {
      await client.startEmailLogin({ version: 2, email });
      setState({ phase: 'sent' });
    } catch (error: unknown) {
      setState({
        phase: 'error',
        message: error instanceof Error ? error.message : 'Sign-in could not be started.',
      });
    }
  }

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to sign in
      </a>
      <div className="public-theme-control">
        <ThemeToggle />
      </div>
      <main id="main-content" className="login-shell" tabIndex={-1}>
        <section className="login-panel" aria-labelledby="login-heading">
          <p className="eyebrow">BOTMEM WEB / PRIVATE ACCESS</p>
          <h1 id="login-heading">Open your memory.</h1>
          <p className="login-lede">
            Botmem sends a single-use sign-in link. Your source credentials never enter this page.
          </p>

          {state.phase === 'sent' ? (
            <div className="login-result" role="status" aria-live="polite">
              <strong>Check your email.</strong>
              <p>
                If this account exists, its sign-in link is on the way. It expires in 15 minutes.
              </p>
            </div>
          ) : (
            <form className="login-form" onSubmit={submit}>
              <label htmlFor="login-email">Email</label>
              <input
                id="login-email"
                name="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
                placeholder="you@example.com"
              />

              {state.phase === 'error' ? (
                <p className="field-error" role="alert">
                  {state.message}
                </p>
              ) : null}
              <button type="submit" disabled={state.phase === 'sending'}>
                {state.phase === 'sending' ? 'Sending…' : 'Send sign-in link'}
              </button>
            </form>
          )}
        </section>
        <aside className="login-proof" aria-label="Privacy guarantees">
          <strong>ZERO CONTENT IN THE BROWSER LOGIN</strong>
          <ul>
            <li>One-use link</li>
            <li>HttpOnly session</li>
            <li>Local messages stay on device</li>
          </ul>
          <a className="text-link" href="/privacy">
            Read the actual data boundaries
          </a>
        </aside>
      </main>
    </>
  );
}
