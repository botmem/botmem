import { useEffect, useState } from 'react';
import type { BillingStatusResponse } from '@botmem-v2/contracts';
import type { BotmemWebClient } from './data-client.js';

export function BillingPanel({
  client,
  workspaceId,
  navigateExternal = (url) => window.location.assign(url),
}: {
  readonly client: BotmemWebClient;
  readonly workspaceId: string;
  readonly navigateExternal?: (url: string) => void;
}) {
  const [status, setStatus] = useState<BillingStatusResponse>();
  const [error, setError] = useState<string>();
  const [opening, setOpening] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    async function load() {
      try {
        const value = await client.getBillingStatus(workspaceId);
        if (!cancelled) setStatus(value);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'Billing status failed.');
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [client, reload, workspaceId]);

  async function portal() {
    setOpening(true);
    setError(undefined);
    try {
      const created = await client.createBillingPortal(workspaceId);
      navigateExternal(created.portalUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Billing Portal is unavailable.');
      setOpening(false);
    }
  }

  return (
    <main id="main-content" className="billing-shell" tabIndex={-1}>
      <section className="billing-panel" aria-labelledby="billing-heading">
        <p className="eyebrow">SUBSCRIPTION / STRIPE CUSTOMER PORTAL</p>
        <h1 id="billing-heading">Billing without lock-in.</h1>
        {error ? (
          <div className="field-error" role="alert">
            <p>{error}</p>
            <button type="button" onClick={() => setReload((value) => value + 1)}>
              Retry billing status
            </button>
          </div>
        ) : !status ? (
          <p role="status">Loading canonical subscription state…</p>
        ) : (
          <dl className="billing-facts">
            <div>
              <dt>Status</dt>
              <dd>{status.subscriptionStatus}</dd>
            </div>
            <div>
              <dt>Product access</dt>
              <dd>{status.entitled ? 'Active' : 'Paused'}</dd>
            </div>
            {status.currentPeriodEnd ? (
              <div>
                <dt>Current period ends</dt>
                <dd>{new Date(status.currentPeriodEnd).toLocaleDateString()}</dd>
              </div>
            ) : null}
          </dl>
        )}
        <button type="button" onClick={portal} disabled={opening}>
          {opening ? 'Opening Stripe…' : 'Manage subscription'}
        </button>
        <p className="field-hint">
          Cancellation and payment-method changes happen in Stripe's hosted portal.
        </p>
      </section>
    </main>
  );
}
