import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BridgePage } from '../BridgePage';
import { useBridgeStore } from '../../store/bridgeStore';
import type { LiveBridgeStatus } from '../../lib/api';

// Real store, but stub the polling lifecycle so tests stay deterministic.
const startPolling = vi.fn();
const stopPolling = vi.fn();
const fetchStatus = vi.fn();

function setStore(
  partial: Partial<{ status: LiveBridgeStatus | null; loading: boolean; error: string | null }>,
) {
  useBridgeStore.setState({
    status: null,
    loading: false,
    error: null,
    startPolling,
    stopPolling,
    fetchStatus,
    ...partial,
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <BridgePage />
    </MemoryRouter>,
  );
}

describe('BridgePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setStore({});
  });

  it('starts polling on mount and stops on unmount', () => {
    const { unmount } = renderPage();
    expect(startPolling).toHaveBeenCalled();
    unmount();
    expect(stopPolling).toHaveBeenCalled();
  });

  it('shows ONLINE and the sources table when the bridge is online', () => {
    setStore({
      status: {
        online: true,
        flagEnabled: true,
        sources: [
          { source: 'whatsapp', count: 1234, lastIndexedAt: '2026-06-12T00:00:00.000Z' },
          { source: 'imessage', count: 56, lastIndexedAt: null },
        ],
      },
    });
    renderPage();

    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(screen.getByText('WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('iMessage')).toBeInTheDocument();
    expect(screen.getByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('Sources Served')).toBeInTheDocument();
  });

  it('shows OFFLINE and connect instructions when the bridge is offline', () => {
    setStore({ status: { online: false, flagEnabled: true } });
    renderPage();

    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.getByText('Connect Your Mac')).toBeInTheDocument();
    expect(screen.getByText('Run on your Mac')).toBeInTheDocument();
    // No sources table when offline.
    expect(screen.queryByText('Sources Served')).not.toBeInTheDocument();
  });

  it('surfaces the live-routing-disabled note when the flag is off', () => {
    setStore({ status: { online: true, flagEnabled: false, sources: [] } });
    renderPage();
    expect(screen.getByText(/Live routing is currently disabled/i)).toBeInTheDocument();
  });

  it('shows a plain loading state before the first status arrives', () => {
    setStore({ status: null, loading: true });
    renderPage();
    expect(screen.getByText('Checking bridge status…')).toBeInTheDocument();
  });

  it('shows a plain error state and retries on click', () => {
    setStore({ status: null, error: 'boom' });
    renderPage();

    expect(screen.getByText(/Couldn't load bridge status: boom/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(fetchStatus).toHaveBeenCalled();
  });

  it('copies the placeholder run command to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    setStore({ status: { online: false, flagEnabled: true } });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith('npx @botmem/bridge start --pair');
  });
});
