import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '../ui/Button';
import { api } from '../../lib/api';

interface BillingData {
  enabled: boolean;
  plan?: string;
  status?: string;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
}

export function BillingTab() {
  const [billing, setBilling] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getBillingInfo()
      .then(setBilling)
      .catch(() => setBilling({ enabled: false }))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div
        className="h-24 border-3 border-nb-border bg-nb-surface-muted"
        style={{ animation: 'pulse-bar 1.5s ease-in-out infinite' }}
      />
    );
  }

  if (!billing?.enabled) {
    return (
      <>
        <h2 className="font-display text-lg font-bold uppercase tracking-wider text-nb-text mb-1">
          BILLING
        </h2>
        <div className="flex items-center gap-3 mt-4 p-4 border-3 border-nb-green bg-nb-surface-muted">
          <span className="font-display text-sm font-bold uppercase text-nb-green">
            ALL FEATURES UNLOCKED
          </span>
          <span className="font-mono text-xs text-nb-muted">(self-hosted)</span>
        </div>
      </>
    );
  }

  const isPro = billing.plan === 'pro';
  const isPastDue = billing.status === 'past_due';

  const handleUpgrade = async () => {
    setError(null);
    setRedirecting(true);
    try {
      const { url } = await api.createCheckoutSession();
      window.location.href = url;
    } catch (e: any) {
      setError(e?.message || 'Failed to start checkout');
      setRedirecting(false);
    }
  };

  const handleManage = async () => {
    setError(null);
    setRedirecting(true);
    try {
      const { url } = await api.createPortalSession();
      window.location.href = url;
    } catch (e: any) {
      setError(e?.message || 'Failed to open billing portal');
      setRedirecting(false);
    }
  };

  return (
    <>
      <h2 className="font-display text-lg font-bold uppercase tracking-wider text-nb-text mb-1">
        BILLING
      </h2>
      <p className="font-mono text-xs text-nb-muted mb-6">Manage your subscription plan.</p>

      {error && (
        <div className="p-3 mb-4 border-3 border-nb-red bg-nb-surface-muted">
          <p className="font-mono text-xs text-nb-red">{error}</p>
        </div>
      )}

      {isPastDue && (
        <div className="p-3 mb-4 border-3 border-nb-red bg-nb-surface-muted">
          <p className="font-display text-sm font-bold uppercase text-nb-red">PAYMENT FAILED</p>
          <p className="font-mono text-xs text-nb-muted mt-1">
            Your last payment failed. Please update your payment method to keep your Pro features.
          </p>
          <Button
            variant="danger"
            size="sm"
            className="mt-2"
            onClick={handleManage}
            disabled={redirecting}
          >
            UPDATE PAYMENT METHOD
          </Button>
        </div>
      )}

      <div className="flex items-center gap-3 mb-4">
        <span
          className={cn(
            'inline-block px-3 py-1 border-3 font-display text-sm font-bold uppercase tracking-wider',
            isPro
              ? 'border-nb-lime text-nb-lime bg-nb-surface-muted'
              : 'border-nb-border text-nb-muted bg-nb-surface-muted',
          )}
        >
          {isPro ? 'PRO' : 'FREE'}
        </span>
        {isPro && billing.currentPeriodEnd && (
          <span className="font-mono text-xs text-nb-muted">
            Renews {new Date(billing.currentPeriodEnd).toLocaleDateString()}
          </span>
        )}
      </div>

      {isPro ? (
        <div>
          <div className="p-4 border-3 border-nb-lime/30 bg-nb-surface-muted mb-4">
            <p className="font-mono text-xs text-nb-muted">Your Pro plan includes:</p>
            <ul className="font-mono text-xs text-nb-text mt-2 flex flex-col gap-1">
              <li>Unlimited connectors</li>
              <li>Priority enrichment pipeline</li>
              <li>Advanced search &amp; analytics</li>
              <li>API access</li>
            </ul>
          </div>
          <button
            onClick={handleManage}
            disabled={redirecting}
            className="font-mono text-xs text-nb-muted underline underline-offset-2 hover:text-nb-text transition-colors cursor-pointer disabled:opacity-50"
          >
            {redirecting ? 'Redirecting...' : 'Cancel or update payment method'}
          </button>
        </div>
      ) : (
        <div>
          <div className="mb-4 p-4 border-3 border-nb-border bg-nb-surface-muted">
            <p className="font-display text-sm font-bold uppercase text-nb-text mb-2">
              PRO PLAN — $14.99/MO
            </p>
            <ul className="font-mono text-xs text-nb-muted flex flex-col gap-1">
              <li>Unlimited connectors</li>
              <li>Priority enrichment pipeline</li>
              <li>Advanced search &amp; analytics</li>
              <li>API access</li>
            </ul>
          </div>
          <Button onClick={handleUpgrade} disabled={redirecting}>
            {redirecting ? 'REDIRECTING...' : 'UPGRADE TO PRO'}
          </Button>
        </div>
      )}
    </>
  );
}
