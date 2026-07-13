import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DevicePairingPanel } from './DevicePairingPanel.js';
import type { BotmemWebClient } from './data-client.js';

const WORKSPACE_ID = '8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf';

describe('DevicePairingPanel', () => {
  it('removes an expired single-use payload from the document', async () => {
    vi.useFakeTimers();
    try {
      const client = pairingClient({
        payload: 'botmem-device-setup-payload',
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
      });
      render(
        <DevicePairingPanel
          client={client}
          workspaceId={WORKSPACE_ID}
          macRelease={{ available: false }}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Generate Mac setup' }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByLabelText('One-time setup payload')).toHaveValue(
        'botmem-device-setup-payload',
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(screen.queryByLabelText('One-time setup payload')).not.toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent(/payload expired/u);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the payload selectable and explains manual copy after clipboard denial', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const client = pairingClient({
      payload: 'copy-this-payload-manually',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    render(
      <DevicePairingPanel
        client={client}
        workspaceId={WORKSPACE_ID}
        macRelease={{ available: false }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Generate Mac setup' }));
    const payload = await screen.findByLabelText('One-time setup payload');
    fireEvent.click(screen.getByRole('button', { name: 'Copy setup payload' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/copy the payload manually/u);
    expect(payload).toHaveValue('copy-this-payload-manually');
    expect(writeText).toHaveBeenCalledWith('copy-this-payload-manually');
  });
});

function pairingClient(setup: { readonly payload: string; readonly expiresAt: string }) {
  return {
    issueDeviceSetup: vi.fn<BotmemWebClient['issueDeviceSetup']>(async () => setup),
  } as unknown as BotmemWebClient;
}
