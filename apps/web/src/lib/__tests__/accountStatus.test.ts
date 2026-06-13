import { describe, expect, it } from 'vitest';
import type { ConnectorAccount, Job } from '@botmem/shared';
import { accountStatusView } from '../accountStatus';

const account: ConnectorAccount = {
  id: 'a1',
  type: 'gmail',
  identifier: 'test',
  status: 'connected',
  schedule: 'manual',
  lastSync: null,
  memoriesIngested: 0,
  contactsCount: 0,
  groupsCount: 0,
  lastError: null,
};

const job: Job = {
  id: 'j1',
  connector: 'gmail',
  accountId: 'a1',
  accountIdentifier: 'test',
  status: 'queued',
  priority: 0,
  progress: 2,
  total: 5,
  startedAt: null,
  completedAt: null,
  error: null,
};

describe('accountStatusView', () => {
  it('uses the active job as the visible account status', () => {
    expect(accountStatusView(account, [job])).toMatchObject({
      status: 'queued',
      label: 'QUEUED',
      progressText: '2/5',
    });
  });

  it('normalizes Apple bridge failures to bridge offline', () => {
    expect(
      accountStatusView({
        ...account,
        type: 'imessage',
        status: 'failed',
        syncHealth: {
          phase: null,
          lastActivityAt: null,
          activeJobId: null,
          queuedJobId: null,
          progress: null,
          total: null,
          recoveryAction: 'start_bridge',
          recoveryReason: 'bridge stopped',
        },
      }),
    ).toMatchObject({
      status: 'bridge_offline',
      label: 'BRIDGE OFFLINE',
    });
  });

  it('normalizes sync failures to sync failed', () => {
    expect(accountStatusView({ ...account, status: 'failed' })).toMatchObject({
      status: 'sync_failed',
      label: 'SYNC FAILED',
    });
  });
});
