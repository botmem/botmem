import type { ConnectorAccount } from '@botmem/shared';
import { formatRelative, CONNECTOR_COLORS } from '@botmem/shared';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';

const statusColors: Record<string, string> = {
  connected: '#22C55E',
  syncing: '#4ECDC4',
  error: '#EF4444',
  disconnected: '#9CA3AF',
};

interface ConnectorAccountRowProps {
  account: ConnectorAccount;
  onRemove: (id: string) => void;
  onSyncNow: (id: string) => void;
}

export function ConnectorAccountRow({ account, onRemove, onSyncNow }: ConnectorAccountRowProps) {
  return (
    <div className="border-3 border-nb-border bg-nb-surface">
      <div className="flex items-center justify-between p-3">
        <div className="flex items-center gap-3">
          <div
            className="w-3 h-3 border-2 border-nb-border"
            style={{ backgroundColor: CONNECTOR_COLORS[account.type] }}
          />
          <div>
            <p className="font-mono text-sm font-bold text-nb-text">{account.identifier}</p>
            <p className="font-mono text-xs text-nb-muted">
              {account.lastSync ? `Synced ${formatRelative(account.lastSync)}` : 'Never synced'} • {account.memoriesIngested} memories
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge color={statusColors[account.status]}>{account.status}</Badge>
          <Badge>{account.schedule}</Badge>
          <Button size="sm" variant="secondary" onClick={() => onSyncNow(account.id)}>
            SYNC
          </Button>
          <Button size="sm" variant="danger" onClick={() => onRemove(account.id)}>
            ✕
          </Button>
        </div>
      </div>
      {account.status === 'error' && account.lastError && (
        <div className="border-t-3 border-nb-border px-3 py-2 bg-red-950/30">
          <p className="font-mono text-xs text-nb-red">
            <span className="font-bold uppercase">Error: </span>
            {account.lastError}
          </p>
        </div>
      )}
    </div>
  );
}
