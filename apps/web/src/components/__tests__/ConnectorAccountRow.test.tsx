import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ConnectorAccount } from '@botmem/shared';
import { ConnectorAccountRow } from '../connectors/ConnectorAccountRow';
import { useMemoryBankStore } from '../../store/memoryBankStore';
import { useJobStore } from '../../store/jobStore';
import { api } from '../../lib/api';

vi.mock('../../lib/api', () => ({
  api: {
    getBridgeStatus: vi.fn().mockResolvedValue({
      connected: false,
      accountId: 'a1',
      sources: null,
      lastSeenAt: null,
      lastError: null,
    }),
  },
}));

const mockGetBridgeStatus = vi.mocked(api.getBridgeStatus);

const baseAccount: ConnectorAccount = {
  id: 'a1',
  type: 'whatsapp',
  identifier: 'wa',
  status: 'connected',
  schedule: 'manual',
  lastSync: null,
  memoriesIngested: 0,
  contactsCount: 0,
  groupsCount: 0,
  lastError: null,
};
const baseJobState = useJobStore.getState();

describe('ConnectorAccountRow', () => {
  beforeEach(() => {
    useMemoryBankStore.setState({ memoryBanks: [], activeMemoryBankId: null });
    useJobStore.setState({ ...baseJobState, jobs: [], logsByAccount: {}, notifications: [] });
    mockGetBridgeStatus.mockReset();
    mockGetBridgeStatus.mockResolvedValue({
      connected: false,
      accountId: 'a1',
      sources: null,
      lastSeenAt: null,
      lastError: null,
    });
  });

  it('shows QR recovery action for reconnect_required WhatsApp accounts', () => {
    const onEdit = vi.fn();
    render(
      <ConnectorAccountRow
        account={{
          ...baseAccount,
          status: 'reconnect_required',
          lastError: 'WhatsApp session files missing',
          syncHealth: {
            phase: null,
            lastActivityAt: null,
            activeJobId: null,
            queuedJobId: null,
            progress: null,
            total: null,
            recoveryAction: 'rescan_qr',
            recoveryReason: 'WhatsApp session files missing',
          },
        }}
        authType="qr-code"
        onRemove={vi.fn()}
        onSyncNow={vi.fn()}
        onEdit={onEdit}
      />,
    );

    expect(screen.getByText('RECONNECT REQUIRED')).toBeInTheDocument();
    expect(screen.getByText(/WhatsApp session files missing/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('RE-SCAN QR'));
    expect(onEdit).toHaveBeenCalledWith('a1');
  });

  it('shows active phase and progress for queued or syncing accounts', () => {
    render(
      <ConnectorAccountRow
        account={{
          ...baseAccount,
          status: 'queued',
          syncHealth: {
            phase: 'Queued for sync',
            lastActivityAt: '2026-04-30T00:00:00.000Z',
            activeJobId: null,
            queuedJobId: 'j1',
            progress: 2,
            total: 10,
            recoveryAction: null,
            recoveryReason: null,
          },
        }}
        onRemove={vi.fn()}
        onSyncNow={vi.fn()}
      />,
    );

    expect(screen.getByText('QUEUED')).toBeInTheDocument();
    expect(screen.getByText('Queued for sync 2/10')).toBeInTheDocument();
  });

  it('shows job activity and loads logs', () => {
    const fetchLogs = vi.fn();
    useJobStore.setState((state) => ({
      ...state,
      jobs: [
        {
          id: 'j1',
          connector: 'whatsapp',
          accountId: 'a1',
          accountIdentifier: 'wa',
          status: 'running',
          priority: 0,
          progress: 3,
          total: 8,
          startedAt: null,
          completedAt: null,
          error: null,
        },
      ],
      logsByAccount: {
        a1: [
          {
            id: 'l1',
            timestamp: '2026-06-12T00:00:00.000Z',
            level: 'info',
            connector: 'whatsapp',
            stage: 'sync',
            message: 'started sync',
          },
        ],
      },
      fetchLogs,
    }));

    render(<ConnectorAccountRow account={baseAccount} onRemove={vi.fn()} onSyncNow={vi.fn()} />);

    expect(screen.getByText('SYNCING')).toBeInTheDocument();
    expect(screen.getByText('3/8')).toBeInTheDocument();
    expect(screen.getByText(/LAST JOB running 3\/8/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('VIEW LOGS'));
    expect(fetchLogs).toHaveBeenCalledWith('a1', 'j1');
    expect(screen.getByText(/started sync/)).toBeInTheDocument();
  });

  it('shows Botmem CLI recovery copy for failed iMessage bridge accounts', () => {
    render(
      <ConnectorAccountRow
        account={{
          ...baseAccount,
          id: 'apple-msg-1',
          type: 'imessage',
          status: 'failed',
          lastError: 'iMessage bridge not connected',
          syncHealth: {
            phase: null,
            lastActivityAt: null,
            activeJobId: null,
            queuedJobId: null,
            progress: null,
            total: null,
            recoveryAction: 'start_bridge',
            recoveryReason: 'iMessage bridge not connected',
          },
        }}
        onRemove={vi.fn()}
        onSyncNow={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getByText(/botmem sync/)).toHaveTextContent('botmem sync apple-msg-1');
    expect(screen.getByText('BRIDGE OFFLINE')).toBeInTheDocument();
    expect(screen.getByText('Bridge offline:')).toBeInTheDocument();
  });

  it('labels Apple bridge recovery as reconnect bridge', () => {
    const onEdit = vi.fn();
    render(
      <ConnectorAccountRow
        account={{
          ...baseAccount,
          id: 'apple-1',
          type: 'apple',
          status: 'failed',
          lastError: 'Apple bridge not connected',
          syncHealth: {
            phase: null,
            lastActivityAt: null,
            activeJobId: null,
            queuedJobId: null,
            progress: null,
            total: null,
            recoveryAction: 'start_bridge',
            recoveryReason: 'Apple bridge not connected',
          },
        }}
        onRemove={vi.fn()}
        onSyncNow={vi.fn()}
        onEdit={onEdit}
      />,
    );

    fireEvent.click(screen.getByText('RECONNECT BRIDGE'));
    expect(onEdit).toHaveBeenCalledWith('apple-1');
  });

  it('dedupes Apple bridge remediation copy in the error banner', () => {
    const remediation =
      'Start the Botmem Apple bridge from connector setup, then run `botmem sync apple-msg-1`.';
    render(
      <ConnectorAccountRow
        account={{
          ...baseAccount,
          id: 'apple-msg-1',
          type: 'imessage',
          status: 'failed',
          lastError: `iMessage bridge not connected ${remediation}`,
        }}
        onRemove={vi.fn()}
        onSyncNow={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getByText(/iMessage bridge not connected/).closest('p')).toHaveTextContent(
      'iMessage bridge not connected',
    );
    expect(screen.getAllByText(/Start the Botmem Apple bridge/)).toHaveLength(1);
  });

  it('shows SYNC button and schedule selector for non-bridge connectors (gmail)', () => {
    render(
      <ConnectorAccountRow
        account={{ ...baseAccount, id: 'gmail-1', type: 'gmail', schedule: 'daily' }}
        onRemove={vi.fn()}
        onSyncNow={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getByText('SYNC')).toBeInTheDocument();
    expect(screen.getByLabelText('Select sync schedule')).toBeInTheDocument();
    // Non-bridge connectors never poll the live bridge status endpoint.
    expect(mockGetBridgeStatus).not.toHaveBeenCalled();
  });

  it('hides SYNC button and schedule selector for apple bridge connectors', () => {
    render(
      <ConnectorAccountRow
        account={{ ...baseAccount, id: 'apple-1', type: 'apple', schedule: 'daily' }}
        onRemove={vi.fn()}
        onSyncNow={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.queryByText('SYNC')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Select sync schedule')).not.toBeInTheDocument();
    expect(screen.queryByText('REALTIME')).not.toBeInTheDocument();
    // Delete control stays available.
    expect(screen.getByText('X')).toBeInTheDocument();
  });

  it('hides SYNC button and schedule selector for imessage bridge connectors', () => {
    render(
      <ConnectorAccountRow
        account={{ ...baseAccount, id: 'imsg-1', type: 'imessage', schedule: 'daily' }}
        onRemove={vi.fn()}
        onSyncNow={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.queryByText('SYNC')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Select sync schedule')).not.toBeInTheDocument();
  });

  it('shows OFFLINE for a disconnected apple bridge account', () => {
    render(
      <ConnectorAccountRow
        account={{ ...baseAccount, id: 'apple-1', type: 'apple', status: 'disconnected' }}
        onRemove={vi.fn()}
        onSyncNow={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getByText('OFFLINE')).toBeInTheDocument();
    expect(screen.queryByText(/Never synced/)).not.toBeInTheDocument();
  });

  it('flips the apple bridge row to ONLINE once the live status poll resolves connected', async () => {
    mockGetBridgeStatus.mockResolvedValue({
      connected: true,
      accountId: 'apple-1',
      sources: { contacts: true, imessages: true },
      lastSeenAt: '2026-06-12T00:00:00.000Z',
      lastError: null,
    });

    render(
      <ConnectorAccountRow
        account={{ ...baseAccount, id: 'apple-1', type: 'apple', status: 'connected' }}
        onRemove={vi.fn()}
        onSyncNow={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    // 'ONLINE' shows immediately from the account.status fallback, so wait on the
    // poll-driven sources text instead — that only renders after getBridgeStatus resolves.
    await waitFor(() => expect(screen.getByText(/iMessages, Contacts/)).toBeInTheDocument());
    expect(screen.getByText('ONLINE')).toBeInTheDocument();
    expect(mockGetBridgeStatus).toHaveBeenCalledWith('apple-1');
  });
});
