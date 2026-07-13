import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BotmemWebClient } from './data-client.js';
import { LoginPage } from './LoginPage.js';

describe('LoginPage', () => {
  it('submitsTheCanonicalRequestAndShowsTheNonEnumeratingResult', async () => {
    const startEmailLogin = vi.fn().mockResolvedValue({
      version: 2,
      status: 'accepted',
      message: 'If the account exists, a sign-in link has been sent',
    });
    const client = { startEmailLogin } as unknown as BotmemWebClient;
    const user = userEvent.setup();
    render(<LoginPage client={client} />);

    await user.type(screen.getByLabelText('Email'), 'me@example.com');
    await user.click(screen.getByRole('button', { name: 'Send sign-in link' }));

    expect(startEmailLogin).toHaveBeenCalledWith({
      version: 2,
      email: 'me@example.com',
    });
    expect(await screen.findByText('Check your email.')).toBeInTheDocument();
    expect(screen.getByText(/If this account exists/u)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skip to sign in' })).toHaveAttribute(
      'href',
      '#main-content',
    );
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    await user.click(screen.getByRole('button', { name: 'Use light theme' }));
    expect(document.documentElement.dataset['theme']).toBe('light');
  });

  it('does not submit an empty or malformed email address', async () => {
    const startEmailLogin = vi.fn();
    const user = userEvent.setup();
    render(<LoginPage client={{ startEmailLogin } as unknown as BotmemWebClient} />);

    await user.click(screen.getByRole('button', { name: 'Send sign-in link' }));
    expect(startEmailLogin).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Send sign-in link' }));
    expect(startEmailLogin).not.toHaveBeenCalled();
  });
});
