import type { ConnectorAccount } from '@botmem/shared';
import { formatRelative, CONNECTOR_COLORS, cn } from '@botmem/shared';
import { useConnectors } from '../../hooks/useConnectors';

const statusConfig: Record<string, { label: string; color: string; pulse?: boolean }> = {
  syncing: { label: 'SYNCING', color: 'var(--color-nb-lime)', pulse: true },
  connected: { label: 'IDLE', color: 'var(--color-nb-muted)' },
  error: { label: 'ERROR', color: 'var(--color-nb-red)' },
  disconnected: { label: 'DISCONNECTED', color: 'var(--color-nb-orange)' },
};

function ConnectorRow({ account }: { account: ConnectorAccount }) {
  const status = statusConfig[account.status] ?? statusConfig.connected;
  const connectorColor = CONNECTOR_COLORS[account.type] ?? 'var(--color-nb-muted)';

  return (
    <div className="border-3 border-nb-border bg-nb-surface">
      <div className="flex items-center justify-between px-3 py-2 gap-3">
        {/* Left: connector identity */}
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="size-2.5 shrink-0 border border-nb-border"
            style={{ backgroundColor: connectorColor }}
          />
          <span className="font-display text-xs font-bold uppercase tracking-wider text-nb-text truncate">
            {account.type}
          </span>
        </div>

        {/* Center: stats */}
        <div className="hidden sm:flex items-center gap-3 font-mono text-xs text-nb-muted shrink-0">
          <span>{account.memoriesIngested.toLocaleString()} mem</span>
          {account.contactsCount > 0 && <span>{account.contactsCount.toLocaleString()} ppl</span>}
        </div>

        {/* Right: status + last sync */}
        <div className="flex items-center gap-2.5 shrink-0">
          <span className="font-mono text-xs text-nb-muted hidden sm:inline">
            {account.lastSync ? formatRelative(account.lastSync) : 'never'}
          </span>
          <div className="flex items-center gap-1.5">
            <div
              className={cn('size-2 border border-nb-border', status.pulse && 'animate-pulse')}
              style={{ backgroundColor: status.color }}
            />
            <span
              className="font-display text-[10px] font-bold uppercase tracking-wider"
              style={{ color: status.color }}
            >
              {status.label}
            </span>
          </div>
        </div>
      </div>

      {/* Error banner */}
      {account.lastError && (account.status === 'error' || account.status === 'disconnected') && (
        <div
          className={cn(
            'border-t-3 border-nb-border px-3 py-1.5',
            account.status === 'error' ? 'bg-red-950/30' : 'bg-orange-950/30',
          )}
        >
          <p
            className={cn(
              'font-mono text-[11px] truncate',
              account.status === 'error' ? 'text-nb-red' : 'text-orange-400',
            )}
          >
            {account.lastError}
          </p>
        </div>
      )}
    </div>
  );
}

export function ConnectorStatusBar() {
  const { accounts } = useConnectors();

  if (accounts.length === 0) return null;

  return (
    <section aria-label="Connector sync status">
      <h2 className="font-display text-xs font-bold uppercase tracking-wider text-nb-muted mb-2">
        Connectors
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {accounts.map((account) => (
          <ConnectorRow key={account.id} account={account} />
        ))}
      </div>
    </section>
  );
}
