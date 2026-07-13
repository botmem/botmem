import { StripeCheckoutSessionIdSchema } from '@botmem-v2/contracts';
import { useEffect, useState } from 'react';
import { loadBrowserBillingDraft } from './billing-state.js';
import type { BotmemWebClient } from './data-client.js';
import { rememberBrowserWorkspace } from './login-state.js';
import { ThemeToggle } from './ThemeToggle.js';

interface SignupCompletePageProps {
  readonly client: BotmemWebClient;
  readonly sessionId?: string;
  readonly pollDelayMs?: number;
  readonly maximumPolls?: number;
}

type CompletionState =
  | { readonly phase: 'checking' }
  | { readonly phase: 'signin_sent' }
  | { readonly phase: 'signin_required' }
  | { readonly phase: 'inactive' | 'expired' | 'failed' | 'timeout' }
  | { readonly phase: 'error'; readonly message: string };

export function SignupCompletePage({
  client,
  sessionId,
  pollDelayMs = 1_500,
  maximumPolls = 80,
}: SignupCompletePageProps) {
  const parsedSession = StripeCheckoutSessionIdSchema.safeParse(sessionId);
  const [state, setState] = useState<CompletionState>(
    parsedSession.success
      ? { phase: 'checking' }
      : { phase: 'error', message: 'The Checkout completion link is invalid.' },
  );

  useEffect(() => {
    if (!parsedSession.success) return;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    void (async () => {
      for (let poll = 0; poll < maximumPolls && !controller.signal.aborted; poll += 1) {
        try {
          const status = await client.getBillingCheckoutStatus(
            parsedSession.data,
            controller.signal,
          );
          if (status.status === 'active') {
            rememberBrowserWorkspace(status.workspaceId);
            const draft = loadBrowserBillingDraft();
            if (!draft) {
              setState({ phase: 'signin_required' });
              return;
            }
            await client.startEmailLogin({ version: 2, email: draft.email });
            setState({ phase: 'signin_sent' });
            return;
          }
          if (status.status !== 'pending') {
            setState({ phase: status.status });
            return;
          }
          await new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, pollDelayMs);
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          setState({
            phase: 'error',
            message: error instanceof Error ? error.message : 'Checkout status is unavailable.',
          });
          return;
        }
      }
      if (!controller.signal.aborted) setState({ phase: 'timeout' });
    })();
    return () => {
      controller.abort();
      if (timeout) clearTimeout(timeout);
    };
  }, [client, maximumPolls, parsedSession.success, parsedSession.data, pollDelayMs]);

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to completion status
      </a>
      <div className="public-theme-control">
        <ThemeToggle />
      </div>
      <main id="main-content" className="completion-shell" tabIndex={-1}>
        <section className="completion-panel" aria-live="polite">
          <p className="eyebrow">CHECKOUT RETURN / BOTMEM RECONCILIATION</p>
          {state.phase === 'checking' ? (
            <>
              <h1>Confirming your workspace.</h1>
              <p>Checkout returned. Botmem is waiting for its signed webhook and worker commit.</p>
            </>
          ) : state.phase === 'signin_sent' ? (
            <>
              <h1>Your memory layer is ready.</h1>
              <p>Check your email for the single-use sign-in link.</p>
            </>
          ) : state.phase === 'signin_required' ? (
            <>
              <h1>Your memory layer is ready.</h1>
              <p>Browser storage is unavailable. Sign in with the owner email to continue.</p>
              <a href="/">Return to sign in</a>
            </>
          ) : state.phase === 'inactive' ? (
            <>
              <h1>Payment needs attention.</h1>
              <p>The subscription is not active. No workspace access was granted.</p>
              <a href="/pricing">Try Checkout again</a>
            </>
          ) : state.phase === 'expired' || state.phase === 'failed' ? (
            <>
              <h1>Checkout did not complete.</h1>
              <p>No workspace was provisioned.</p>
              <a href="/pricing">Return to pricing</a>
            </>
          ) : state.phase === 'timeout' ? (
            <>
              <h1>Still reconciling.</h1>
              <p>Your payment is not being guessed. Refresh this page in a moment.</p>
            </>
          ) : state.phase === 'error' ? (
            <>
              <h1>Completion cannot be confirmed.</h1>
              <p role="alert">{state.message}</p>
              <a href="/">Return to sign in</a>
            </>
          ) : null}
        </section>
      </main>
    </>
  );
}
