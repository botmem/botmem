import type { ConnectorAccount, ConnectorStatus } from '@botmem/shared';

type StatusMeta = {
  label: string;
  color: string;
  pulse?: boolean;
  rank: number;
};

export const APPLE_BRIDGE_REMEDIATION =
  'Start the Botmem Apple bridge from connector setup, then run `botmem sync {accountId}`.';

export const accountStatusMeta: Record<ConnectorStatus, StatusMeta> = {
  connected: { label: 'connected', color: 'var(--color-nb-green)', rank: 1 },
  syncing: { label: 'syncing', color: 'var(--color-nb-blue)', pulse: true, rank: 3 },
  queued: { label: 'queued', color: 'var(--color-nb-yellow)', pulse: true, rank: 3 },
  degraded: { label: 'degraded', color: 'var(--color-nb-yellow)', rank: 4 },
  reconnect_required: { label: 'reconnect required', color: 'var(--color-nb-orange)', rank: 5 },
  failed: { label: 'failed', color: 'var(--color-nb-red)', rank: 6 },
  error: { label: 'error', color: 'var(--color-nb-red)', rank: 6 },
  disconnected: { label: 'disconnected', color: 'var(--color-nb-orange)', rank: 5 },
  inactive: { label: 'inactive', color: 'var(--color-nb-muted)', rank: 0 },
  archived: { label: 'archived', color: 'var(--color-nb-muted)', rank: 0 },
};

export function getAccountStatusMeta(status: ConnectorStatus): StatusMeta {
  return accountStatusMeta[status];
}

export function getWorstAccountStatus(accounts: ConnectorAccount[]): StatusMeta | null {
  return accounts.reduce<StatusMeta | null>((worst, account) => {
    const next = getAccountStatusMeta(account.status);
    return !worst || next.rank > worst.rank ? next : worst;
  }, null);
}

export function formatAccountCount(count: number): string {
  return `${count} ${count === 1 ? 'account' : 'accounts'}`;
}

export function appleBridgeRemediation(accountId: string): string {
  return APPLE_BRIDGE_REMEDIATION.replace('{accountId}', accountId);
}
