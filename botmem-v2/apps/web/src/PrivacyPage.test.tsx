import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PrivacyPage } from './PrivacyPage.js';

describe('PrivacyPage', () => {
  it('states the hosted, device-local, processor, export, and deletion boundaries', () => {
    render(<PrivacyPage />);

    expect(screen.getByRole('heading', { name: 'Your messages stay yours.' })).toBeVisible();
    expect(screen.getByText(/Gmail, Outlook, and OwnTracks content/)).toBeVisible();
    expect(
      screen.getByText(/iMessage and WhatsApp corpora and indexes stay on your Mac/),
    ).toBeVisible();
    expect(
      screen.getByText(/default abuse-monitoring logs may retain customer content/),
    ).toBeVisible();
    expect(
      screen.getByText(/ordinary federated search also sends the raw search query/),
    ).toBeVisible();
    expect(screen.getByText(/explicitly filtered to only iMessage or WhatsApp/)).toBeVisible();
    expect(screen.getByText(/does not send local result bodies to OpenAI/)).toBeVisible();
    expect(screen.getByText(/does not silently reach into your Mac/)).toBeVisible();
    expect(screen.getByText(/notice does not remotely erase the Mac/)).toBeVisible();
    expect(screen.getByText(/Hosted deletion does not wait for an offline Mac/)).toBeVisible();
    expect(screen.getByText(/encrypted database backups.*up to 30 days/u)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Skip to privacy disclosure' })).toHaveAttribute(
      'href',
      '#main-content',
    );
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');

    const gate = screen.getByLabelText('Pre-launch legal review required');
    expect(within(gate).getByText('PRE-LAUNCH LEGAL GATE')).toBeVisible();
  });
});
