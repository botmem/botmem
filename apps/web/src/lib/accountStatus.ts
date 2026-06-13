import type { ConnectorAccount, Job } from '@botmem/shared';

const activeStatuses = new Set(['queued', 'running']);
const bridgeTypes = new Set(['apple', 'imessage']);
const failedStatuses = new Set(['failed', 'error']);
const offlineStatuses = new Set(['disconnected', 'reconnect_required']);

export interface AccountStatusView {
  status: string;
  label: string;
  color: string;
  pulse: boolean;
  progressText: string | null;
}

export function activeJobForAccount(accountId: string, jobs: Job[]) {
  return jobs.find((job) => job.accountId === accountId && activeStatuses.has(job.status));
}

export function accountStatusView(account: ConnectorAccount, jobs: Job[] = []): AccountStatusView {
  const activeJob = activeJobForAccount(account.id, jobs);
  if (activeJob) {
    const label = activeJob.status === 'queued' ? 'QUEUED' : 'SYNCING';
    return {
      status: activeJob.status,
      label,
      color:
        activeJob.status === 'queued' ? 'var(--color-nb-yellow)' : 'var(--color-nb-lime)',
      pulse: activeJob.status === 'running',
      progressText:
        activeJob.total > 0 ? `${activeJob.progress ?? 0}/${activeJob.total}` : null,
    };
  }

  if (
    bridgeTypes.has(account.type) &&
    (offlineStatuses.has(account.status) || account.syncHealth?.recoveryAction === 'start_bridge')
  ) {
    return {
      status: 'bridge_offline',
      label: 'BRIDGE OFFLINE',
      color: 'var(--color-nb-orange)',
      pulse: false,
      progressText: null,
    };
  }

  if (failedStatuses.has(account.status)) {
    return {
      status: 'sync_failed',
      label: 'SYNC FAILED',
      color: 'var(--color-nb-red)',
      pulse: false,
      progressText: null,
    };
  }

  if (account.status === 'connected') {
    return {
      status: 'connected',
      label: 'CONNECTED',
      color: 'var(--color-nb-green)',
      pulse: false,
      progressText: null,
    };
  }

  return {
    status: account.status,
    label: account.status.replace(/_/g, ' ').toUpperCase(),
    color: account.status === 'degraded' ? 'var(--color-nb-yellow)' : 'var(--color-nb-muted)',
    pulse: account.status === 'syncing',
    progressText: null,
  };
}
