import { useState } from 'react';
import type { ConnectorAccount, ConnectorManifest, SyncSchedule } from '@botmem/shared';
import { cn, formatRelative, CONNECTOR_COLORS } from '@botmem/shared';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { useMemoryBankStore } from '../../store/memoryBankStore';
import { useConnectorStore } from '../../store/connectorStore';

const SCHEDULE_OPTIONS: Array<{ value: SyncSchedule; label: string }> = [
  { value: 'hourly', label: 'HOURLY' },
  { value: 'every-6h', label: 'EVERY 6H' },
  { value: 'daily', label: 'DAILY' },
  { value: 'manual', label: 'MANUAL' },
];

const statusColors: Record<string, string> = {
  connected: 'var(--color-nb-green)',
  syncing: 'var(--color-nb-blue)',
  queued: 'var(--color-nb-yellow)',
  degraded: 'var(--color-nb-yellow)',
  reconnect_required: 'var(--color-nb-orange)',
  failed: 'var(--color-nb-red)',
  error: 'var(--color-nb-red)',
  disconnected: 'var(--color-nb-orange)',
};

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

function actionLabel(account: ConnectorAccount, authType?: string): string {
  const action = account.syncHealth?.recoveryAction;
  if (action === 'rescan_qr' || authType === 'qr-code') return 'RE-SCAN QR';
  if (action === 'start_bridge') return 'BRIDGE HELP';
  if (action === 'reconnect') return 'RECONNECT';
  return 'EDIT';
}

interface ConnectorAccountRowProps {
  account: ConnectorAccount;
  authType?: string;
  onRemove: (id: string) => void;
  onSyncNow: (id: string, memoryBankId?: string) => void;
  onEdit?: (id: string) => void;
  syncConfig?: ConnectorManifest['sync'];
}

export function ConnectorAccountRow({
  account,
  authType,
  onRemove,
  onSyncNow,
  onEdit,
  syncConfig,
}: ConnectorAccountRowProps) {
  const { memoryBanks, activeMemoryBankId } = useMemoryBankStore();
  const defaultBankId = activeMemoryBankId || memoryBanks.find((b) => b.isDefault)?.id;
  const [selectedBankId, setSelectedBankId] = useState(defaultBankId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const showBankSelector = memoryBanks.length > 1;
  const scheduleConfig = {
    defaultSchedule: syncConfig?.defaultSchedule ?? 'daily',
    configurable: syncConfig?.configurable ?? true,
  };
  const usesManagedSync = !scheduleConfig.configurable;

  return (
    <div className="border-3 border-nb-border bg-nb-surface">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between p-3 gap-2">
        <div className="flex items-center gap-3">
          <div
            className="size-3 border-2 border-nb-border shrink-0"
            style={{ backgroundColor: CONNECTOR_COLORS[account.type] }}
          />
          <div className="min-w-0">
            <p className="font-mono text-sm font-bold text-nb-text truncate">
              {account.identifier}
            </p>
            <p className="font-mono text-xs text-nb-muted">
              {account.lastSync ? `Synced ${formatRelative(account.lastSync)}` : 'Never synced'} •{' '}
              {account.memoriesIngested} memories
              {(account.contactsCount > 0 || account.groupsCount > 0) && (
                <>
                  {' '}
                  • {account.contactsCount > 0 && `${account.contactsCount} people`}
                  {account.contactsCount > 0 && account.groupsCount > 0 && ', '}
                  {account.groupsCount > 0 && `${account.groupsCount} groups`}
                </>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge color={statusColors[account.status]}>{statusLabel(account.status)}</Badge>
          {(account.status === 'syncing' || account.status === 'queued') && account.syncHealth && (
            <span className="font-mono text-xs uppercase text-nb-muted">
              {account.syncHealth.phase || statusLabel(account.status)}
              {account.syncHealth.total && account.syncHealth.total > 0
                ? ` ${account.syncHealth.progress ?? 0}/${account.syncHealth.total}`
                : ''}
            </span>
          )}
          {showBankSelector && (
            <select
              id="sync-memory-bank"
              name="sync-memory-bank"
              value={selectedBankId || ''}
              onChange={(e) => setSelectedBankId(e.target.value || undefined)}
              aria-label="Select memory bank"
              className="appearance-none border-2 border-nb-border bg-nb-surface font-mono text-xs uppercase text-nb-text px-2 py-1.5 focus:outline-none focus:border-nb-lime cursor-pointer"
            >
              {memoryBanks.map((bank) => (
                <option key={bank.id} value={bank.id}>
                  {bank.name}
                  {bank.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </select>
          )}
          {(['error', 'disconnected', 'reconnect_required', 'failed'] as string[]).includes(
            account.status,
          ) &&
            onEdit && (
              <Button
                size="sm"
                variant={account.status === 'reconnect_required' ? 'primary' : 'danger'}
                onClick={() => onEdit(account.id)}
              >
                {actionLabel(account, authType)}
              </Button>
            )}
          {usesManagedSync ? (
            <span className="border-2 border-nb-border bg-nb-surface px-2 py-1.5 font-mono text-xs uppercase text-nb-muted">
              REALTIME
            </span>
          ) : (
            <select
              id="sync-schedule"
              name="sync-schedule"
              value={account.schedule}
              onChange={(e) =>
                useConnectorStore
                  .getState()
                  .updateSchedule(account.id, e.target.value as SyncSchedule)
              }
              aria-label="Select sync schedule"
              className="appearance-none border-2 border-nb-border bg-nb-surface font-mono text-xs uppercase text-nb-text px-2 py-1.5 focus:outline-none focus:border-nb-lime cursor-pointer"
            >
              {SCHEDULE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onSyncNow(account.id, selectedBankId)}
          >
            SYNC
          </Button>
          {confirmDelete ? (
            <>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  onRemove(account.id);
                  setConfirmDelete(false);
                }}
              >
                CONFIRM
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setConfirmDelete(false)}>
                CANCEL
              </Button>
            </>
          ) : (
            <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
              X
            </Button>
          )}
        </div>
      </div>
      {account.lastError && (
        <div
          className={cn(
            'border-t-3 border-nb-border px-3 py-2',
            account.status === 'error' || account.status === 'failed'
              ? 'bg-red-950/30'
              : account.status === 'disconnected' || account.status === 'reconnect_required'
                ? 'bg-orange-950/30'
                : 'bg-yellow-950/30',
          )}
        >
          <p
            className={cn(
              'font-mono text-xs',
              account.status === 'error' || account.status === 'failed'
                ? 'text-nb-red'
                : account.status === 'disconnected' || account.status === 'reconnect_required'
                  ? 'text-orange-400'
                  : 'text-yellow-400',
            )}
          >
            <span className="font-bold uppercase">
              {account.status === 'error' || account.status === 'failed'
                ? 'Error: '
                : account.status === 'disconnected' || account.status === 'reconnect_required'
                  ? 'Reconnect required: '
                  : 'Warning: '}
            </span>
            {account.lastError}
            {(account.type === 'apple' || account.type === 'imessage') &&
              account.status === 'failed' && (
                <span className="block mt-1 text-nb-muted">
                  Start the Botmem Apple bridge from connector setup, then run `botmem sync{' '}
                  {account.id}`.
                </span>
              )}
          </p>
        </div>
      )}
    </div>
  );
}
