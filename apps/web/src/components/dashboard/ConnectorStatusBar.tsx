import type { ConnectorAccount, Job } from '@botmem/shared';
import { formatRelative, CONNECTOR_COLORS, cn } from '@botmem/shared';
import { useConnectorStore } from '../../store/connectorStore';
import { useJobStore } from '../../store/jobStore';
import { accountStatusView } from '../../lib/accountStatus';
import { formatCompactNumber, formatIntegerNumber } from '../../lib/formatNumber';

function ConnectorRow({ account, jobs }: { account: ConnectorAccount; jobs: Job[] }) {
  const status = accountStatusView(account, jobs);
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
          <span title={`${formatIntegerNumber(account.memoriesIngested)} memories`}>
            {formatCompactNumber(account.memoriesIngested)} mem
          </span>
          {account.contactsCount > 0 && (
            <span title={`${formatIntegerNumber(account.contactsCount)} contacts`}>
              {formatCompactNumber(account.contactsCount)} ppl
            </span>
          )}
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
  const accounts = useConnectorStore((s) => s.accounts);
  const jobs = useJobStore((s) => s.jobs);

  if (accounts.length === 0) return null;

  return (
    <section aria-label="Connector sync status">
      <h2 className="font-display text-xs font-bold uppercase tracking-wider text-nb-muted mb-2">
        Connectors
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {accounts.map((account) => (
          <ConnectorRow
            key={account.id}
            account={account}
            jobs={jobs.filter((job) => job.accountId === account.id)}
          />
        ))}
      </div>
    </section>
  );
}
