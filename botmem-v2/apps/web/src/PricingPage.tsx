import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { BillingPriceResponse } from '@botmem-v2/contracts';
import type { BotmemWebClient } from './data-client.js';
import { rememberBillingDraft } from './billing-state.js';

interface PricingPageProps {
  readonly client: BotmemWebClient;
  readonly initialPrice?: BillingPriceResponse;
  readonly checkoutCancelled?: boolean;
  readonly navigate?: (url: string) => void;
}

type CheckoutState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'starting' }
  | { readonly phase: 'error'; readonly message: string };

type PriceState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error' }
  | { readonly phase: 'ready'; readonly price: BillingPriceResponse };

export function PricingPage({
  client,
  initialPrice,
  checkoutCancelled = false,
  navigate = (url) => window.location.assign(url),
}: PricingPageProps) {
  const [email, setEmail] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [state, setState] = useState<CheckoutState>({ phase: 'idle' });
  const [priceState, setPriceState] = useState<PriceState>(
    initialPrice ? { phase: 'ready', price: initialPrice } : { phase: 'loading' },
  );
  const formattedPrice = useMemo(() => {
    if (priceState.phase !== 'ready') return undefined;
    const amount = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: priceState.price.currency.toUpperCase(),
    }).format(priceState.price.unitAmountMinor / 100);
    const interval =
      priceState.price.intervalCount === 1
        ? priceState.price.interval
        : `${priceState.price.intervalCount} ${priceState.price.interval}s`;
    return `${amount} / ${interval}`;
  }, [priceState]);

  useEffect(() => {
    if (initialPrice) return;
    const controller = new AbortController();
    client
      .getBillingPrice(controller.signal)
      .then((loaded) => {
        setPriceState({ phase: 'ready', price: loaded });
      })
      .catch(() => {
        if (!controller.signal.aborted) setPriceState({ phase: 'error' });
      });
    return () => controller.abort();
  }, [client, initialPrice]);

  async function checkout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (priceState.phase !== 'ready' || !priceState.price.checkoutAvailable) {
      setState({
        phase: 'error',
        message: 'Checkout is not open. Botmem did not create a workspace or send payment data.',
      });
      return;
    }
    setState({ phase: 'starting' });
    try {
      const draft = { email: email.trim(), workspaceName: workspaceName.trim() };
      const created = await client.createBillingCheckout({ version: 2, ...draft });
      rememberBillingDraft(window.sessionStorage, draft);
      navigate(created.checkoutUrl);
    } catch (error) {
      setState({
        phase: 'error',
        message: error instanceof Error ? error.message : 'Secure Checkout is unavailable.',
      });
    }
  }

  return (
    <div className="pricing-shell">
      <a className="skip-link" href="#main-content">
        Skip to pricing
      </a>
      <header className="public-header">
        <a className="wordmark" href="/">
          BOTMEM<span aria-hidden="true">//</span>
          <small>V2</small>
        </a>
        <nav className="public-links" aria-label="Public pages">
          <a className="text-link" href="/privacy">
            Privacy
          </a>
          <a className="text-link" href="/">
            Sign in
          </a>
        </nav>
      </header>
      <main id="main-content" tabIndex={-1}>
        <section className="pricing-hero" aria-labelledby="pricing-heading">
          <p className="eyebrow">ONE MEMORY LAYER / YOUR DATA, YOUR RULES</p>
          <h1 id="pricing-heading">Search the life you already lived.</h1>
          <p>
            Gmail, Outlook, OwnTracks, iMessage, and WhatsApp. One evidence-ranked search surface
            for you, your CLI, and your agents.
          </p>
        </section>

        {checkoutCancelled ? (
          <p className="checkout-notice" role="status">
            Checkout was cancelled. Nothing was provisioned.
          </p>
        ) : null}

        <section className="plan-card" aria-labelledby="plan-heading">
          <div className="plan-copy">
            <p className="eyebrow">BOTMEM PERSONAL</p>
            <h2 id="plan-heading">One plan. No data hostage.</h2>
            <p className="plan-price" role="status">
              {formattedPrice ??
                (priceState.phase === 'error'
                  ? 'Pricing temporarily unavailable'
                  : 'Loading exact price…')}
            </p>
            <ul>
              <li>Hosted email and location connectors</li>
              <li>Private Mac bridge for local messages</li>
              <li>Web, CLI, and MCP access</li>
              <li>Cancel through Stripe Billing Portal</li>
            </ul>
          </div>
          <form className="checkout-form" onSubmit={checkout}>
            {priceState.phase === 'ready' && !priceState.price.checkoutAvailable ? (
              <div className="checkout-availability" role="status">
                <strong>CHECKOUT PAUSED</strong>
                <p>
                  Legal and regional disclosures are being finalized. Botmem will not accept payment
                  or provision a workspace until that release gate is approved.
                </p>
              </div>
            ) : null}
            <label htmlFor="signup-email">Owner email</label>
            <input
              id="signup-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              placeholder="you@example.com"
            />
            <label htmlFor="workspace-name">Workspace name</label>
            <input
              id="workspace-name"
              autoComplete="organization"
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              required
              maxLength={128}
              placeholder="My memory"
            />
            {state.phase === 'error' ? (
              <p className="field-error" role="alert">
                {state.message}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={
                state.phase === 'starting' ||
                priceState.phase !== 'ready' ||
                !priceState.price.checkoutAvailable
              }
            >
              {state.phase === 'starting'
                ? 'Opening secure Checkout…'
                : priceState.phase === 'ready' && !priceState.price.checkoutAvailable
                  ? 'Checkout not open yet'
                  : 'Continue to Stripe'}
            </button>
            <p className="field-hint">
              Stripe is the source of truth for the price and collects payment. Taxes, if
              applicable, are shown before confirmation. Botmem creates nothing until a verified
              active subscription reaches the reconciliation worker.
            </p>
          </form>
        </section>
      </main>
    </div>
  );
}
