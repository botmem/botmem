import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ConnectorAccount } from '@botmem/shared';
import { ConnectorAccountRow } from '../connectors/ConnectorAccountRow';
import { useMemoryBankStore } from '../../store/memoryBankStore';
import { useJobStore } from '../../store/jobStore';

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
});
