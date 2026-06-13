import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ConnectorAccount } from '@botmem/shared';
import { ConnectorAccountRow } from '../connectors/ConnectorAccountRow';
import { useMemoryBankStore } from '../../store/memoryBankStore';
import { appleBridgeRemediation } from '../connectors/accountDisplay';

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

describe('ConnectorAccountRow', () => {
  beforeEach(() => {
    useMemoryBankStore.setState({ memoryBanks: [], activeMemoryBankId: null });
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

    expect(screen.getByText('reconnect required')).toBeInTheDocument();
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

    expect(screen.getByText('queued')).toBeInTheDocument();
    expect(screen.getByText('Queued for sync 2/10')).toBeInTheDocument();
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
  });

  it('does not duplicate Apple bridge remediation already present in the error', () => {
    const remediation = appleBridgeRemediation('apple-msg-1');
    render(
      <ConnectorAccountRow
        account={{
          ...baseAccount,
          id: 'apple-msg-1',
          type: 'imessage',
          status: 'failed',
          lastError: remediation,
        }}
        onRemove={vi.fn()}
        onSyncNow={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getAllByText(/Start the Botmem Apple bridge/)).toHaveLength(1);
  });
});
