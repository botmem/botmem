import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rememberBillingDraft } from './billing-state.js';
import type { BotmemWebClient } from './data-client.js';
import { SignupCompletePage } from './SignupCompletePage.js';

const SESSION_ID = 'cs_test_commerce123456';
const WORKSPACE_ID = '81000000-0000-4000-8000-000000000001';

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('SignupCompletePage', () => {
  it('polls only Botmem durable state, then starts enumeration-safe owner login', async () => {
    rememberBillingDraft(window.sessionStorage, {
      email: 'owner@example.test',
      workspaceName: 'My Memory',
    });
    const getBillingCheckoutStatus = vi
      .fn()
      .mockResolvedValueOnce({ version: 2, status: 'pending' })
      .mockResolvedValueOnce({ version: 2, status: 'active', workspaceId: WORKSPACE_ID });
    const startEmailLogin = vi.fn(async () => ({
      version: 2 as const,
      status: 'accepted' as const,
      message: 'If the account exists, a sign-in link has been sent' as const,
    }));
    const client = { getBillingCheckoutStatus, startEmailLogin } as unknown as BotmemWebClient;
    render(
      <SignupCompletePage
        client={client}
        sessionId={SESSION_ID}
        pollDelayMs={1}
        maximumPolls={3}
      />,
    );

    expect(await screen.findByText('Your memory layer is ready.')).toBeVisible();
    expect(getBillingCheckoutStatus).toHaveBeenCalledTimes(2);
    expect(startEmailLogin).toHaveBeenCalledWith({ version: 2, email: 'owner@example.test' });
    await waitFor(() =>
      expect(window.localStorage.getItem('botmem.v2.workspace')).toBe(WORKSPACE_ID),
    );
    expect(screen.getByRole('link', { name: 'Skip to completion status' })).toHaveAttribute(
      'href',
      '#main-content',
    );
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
  });

  it('never treats an invalid redirect capability as proof of payment', () => {
    const client = {
      getBillingCheckoutStatus: vi.fn(),
      startEmailLogin: vi.fn(),
    } as unknown as BotmemWebClient;
    render(<SignupCompletePage client={client} sessionId="not-a-stripe-session" />);
    expect(screen.getByText('Completion cannot be confirmed.')).toBeVisible();
    expect(client.getBillingCheckoutStatus).not.toHaveBeenCalled();
    expect(client.startEmailLogin).not.toHaveBeenCalled();
  });

  it('uses neutral checking copy until Botmem confirms durable active state', () => {
    const client = {
      getBillingCheckoutStatus: vi.fn(() => new Promise(() => {})),
      startEmailLogin: vi.fn(),
    } as unknown as BotmemWebClient;
    render(<SignupCompletePage client={client} sessionId={SESSION_ID} />);

    expect(screen.getByRole('heading', { name: 'Confirming your workspace.' })).toBeVisible();
    expect(screen.getByText(/waiting for its signed webhook and worker commit/u)).toBeVisible();
    expect(screen.queryByText('Your memory layer is ready.')).not.toBeInTheDocument();
  });
});
