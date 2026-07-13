import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BotmemWebClient } from './data-client.js';
import { PricingPage } from './PricingPage.js';

describe('PricingPage', () => {
  it('starts fixed server-side Checkout and redirects only to its returned URL', async () => {
    const createBillingCheckout = vi.fn(async () => ({
      version: 2 as const,
      checkoutUrl: 'https://checkout.stripe.test/session',
      expiresAt: '2026-07-14T12:00:00.000Z',
    }));
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(
      <PricingPage
        client={{ createBillingCheckout } as unknown as BotmemWebClient}
        initialPrice={{
          version: 2,
          currency: 'usd',
          unitAmountMinor: 1_900,
          interval: 'month',
          intervalCount: 1,
          checkoutAvailable: true,
        }}
        navigate={navigate}
      />,
    );

    await user.type(screen.getByLabelText('Owner email'), 'owner@example.test');
    await user.type(screen.getByLabelText('Workspace name'), 'My Memory');
    await user.click(screen.getByRole('button', { name: 'Continue to Stripe' }));

    await waitFor(() =>
      expect(createBillingCheckout).toHaveBeenCalledWith({
        version: 2,
        email: 'owner@example.test',
        workspaceName: 'My Memory',
      }),
    );
    expect(navigate).toHaveBeenCalledWith('https://checkout.stripe.test/session');
    expect(screen.getByText(/\$19\.00 \/ month/u)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Skip to pricing' })).toHaveAttribute(
      'href',
      '#main-content',
    );
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
  });

  it('does not start Checkout until the required identity fields are valid', async () => {
    const createBillingCheckout = vi.fn();
    const user = userEvent.setup();
    render(
      <PricingPage
        client={{ createBillingCheckout } as unknown as BotmemWebClient}
        initialPrice={{
          version: 2,
          currency: 'usd',
          unitAmountMinor: 1_900,
          interval: 'month',
          intervalCount: 1,
          checkoutAvailable: true,
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Continue to Stripe' }));
    expect(createBillingCheckout).not.toHaveBeenCalled();
  });

  it('fails closed when the exact Stripe price is unavailable', async () => {
    const getBillingPrice = vi.fn(async () => {
      throw new Error('unavailable');
    });
    render(<PricingPage client={{ getBillingPrice } as unknown as BotmemWebClient} />);

    expect(await screen.findByText('Pricing temporarily unavailable')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Continue to Stripe' })).toBeDisabled();
  });

  it('shows the server-authoritative legal gate and cannot start Checkout', async () => {
    const createBillingCheckout = vi.fn();
    const user = userEvent.setup();
    render(
      <PricingPage
        client={{ createBillingCheckout } as unknown as BotmemWebClient}
        initialPrice={{
          version: 2,
          currency: 'usd',
          unitAmountMinor: 1_900,
          interval: 'month',
          intervalCount: 1,
          checkoutAvailable: false,
          unavailableReason: 'legal_review_pending',
        }}
      />,
    );

    expect(screen.getByText('CHECKOUT PAUSED')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Checkout not open yet' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Checkout not open yet' }));
    expect(createBillingCheckout).not.toHaveBeenCalled();
  });
});
