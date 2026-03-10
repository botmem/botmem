import { useState } from 'react';
import type { ConnectorAccount, SyncSchedule } from '@botmem/shared';
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
  connected: '#22C55E',
  syncing: '#4ECDC4',
  error: '#EF4444',
  disconnected: '#F97316',
};

interface ConnectorAccountRowProps {
  account: ConnectorAccount;
  authType?: string;
  onRemove: (id: string) => void;
  onSyncNow: (id: string, memoryBankId?: string) => void;
  onEdit?: (id: string) => void;
}

export function ConnectorAccountRow({
  account,
  authType,
  onRemove,
  onSyncNow,
  onEdit,
}: ConnectorAccountRowProps) {
  const { memoryBanks, activeMemoryBankId } = useMemoryBankStore();
  const defaultBankId = activeMemoryBankId || memoryBanks.find((b) => b.isDefault)?.id;
  const [selectedBankId, setSelectedBankId] = useState(defaultBankId);
  const showBankSelector = memoryBanks.length > 1;

  return (
    <div className="border-3 border-nb-border bg-nb-surface">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between p-3 gap-2">
        <div className="flex items-center gap-3">
          <div
            className="w-3 h-3 border-2 border-nb-border shrink-0"
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
          <Badge color={statusColors[account.status]}>{account.status}</Badge>
          {showBankSelector && (
            <select
              value={selectedBankId || ''}
              onChange={(e) => setSelectedBankId(e.target.value || undefined)}
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
          {(account.status === 'error' || account.status === 'disconnected') && onEdit && (
            <Button
              size="sm"
              variant={account.status === 'disconnected' ? 'primary' : 'danger'}
              onClick={() => onEdit(account.id)}
            >
              {authType === 'qr-code' ? 'RECONNECT' : 'EDIT'}
            </Button>
          )}
          <select
            value={account.schedule}
            onChange={(e) => useConnectorStore.getState().updateSchedule(account.id, e.target.value as SyncSchedule)}
            className="appearance-none border-2 border-nb-border bg-nb-surface font-mono text-xs uppercase text-nb-text px-2 py-1.5 focus:outline-none focus:border-nb-lime cursor-pointer"
          >
            {SCHEDULE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onSyncNow(account.id, selectedBankId)}
          >
            SYNC
          </Button>
          <Button size="sm" variant="danger" onClick={() => onRemove(account.id)}>
            X
          </Button>
        </div>
      </div>
      {account.lastError && (
        <div
          className={cn(
            'border-t-3 border-nb-border px-3 py-2',
            account.status === 'error'
              ? 'bg-red-950/30'
              : account.status === 'disconnected'
                ? 'bg-orange-950/30'
                : 'bg-yellow-950/30',
          )}
        >
          <p
            className={cn(
              'font-mono text-xs',
              account.status === 'error'
                ? 'text-nb-red'
                : account.status === 'disconnected'
                  ? 'text-orange-400'
                  : 'text-yellow-400',
            )}
          >
            <span className="font-bold uppercase">
              {account.status === 'error'
                ? 'Error: '
                : account.status === 'disconnected'
                  ? 'Disconnected: '
                  : 'Warning: '}
            </span>
            {account.lastError}
          </p>
        </div>
      )}
    </div>
  );
}
