import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BillingPanel } from './BillingPanel.js';
import type { BotmemWebClient } from './data-client.js';

const WORKSPACE_ID = '81000000-0000-4000-8000-000000000001';

describe('BillingPanel', () => {
  it('keeps Stripe cancellation reachable when the informational status read fails', async () => {
    const getBillingStatus = vi.fn(async () => {
      throw new Error('status unavailable');
    });
    const createBillingPortal = vi.fn(async () => ({
      version: 2 as const,
      portalUrl: 'https://billing.stripe.test/session',
    }));
    const navigateExternal = vi.fn();
    const user = userEvent.setup();
    render(
      <BillingPanel
        client={{ getBillingStatus, createBillingPortal } as unknown as BotmemWebClient}
        workspaceId={WORKSPACE_ID}
        navigateExternal={navigateExternal}
      />,
    );

    expect(await screen.findByText('status unavailable')).toBeVisible();
    const manage = screen.getByRole('button', { name: 'Manage subscription' });
    expect(manage).toBeEnabled();
    await user.click(manage);

    expect(createBillingPortal).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(navigateExternal).toHaveBeenCalledWith('https://billing.stripe.test/session');
  });

  it('can retry the canonical billing status read', async () => {
    const getBillingStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('status unavailable'))
      .mockResolvedValueOnce({
        version: 2,
        workspaceId: WORKSPACE_ID,
        subscriptionStatus: 'active',
        entitled: true,
      });
    const user = userEvent.setup();
    render(
      <BillingPanel
        client={{ getBillingStatus } as unknown as BotmemWebClient}
        workspaceId={WORKSPACE_ID}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Retry billing status' }));
    expect(await screen.findByText('Active')).toBeVisible();
    expect(getBillingStatus).toHaveBeenCalledTimes(2);
  });
});
