import { describe, expect, it } from 'vitest';
import type { ConnectorAccount } from '@botmem/shared';
import { formatAccountCount, getWorstAccountStatus } from '../connectors/accountDisplay';

const account = (status: ConnectorAccount['status']): ConnectorAccount => ({
  id: status,
  type: 'gmail',
  identifier: status,
  status,
  schedule: 'manual',
  lastSync: null,
  memoriesIngested: 0,
  contactsCount: 0,
  groupsCount: 0,
  lastError: null,
});

describe('accountDisplay', () => {
  it('pluralizes account counts', () => {
    expect(formatAccountCount(1)).toBe('1 account');
    expect(formatAccountCount(2)).toBe('2 accounts');
  });

  it('surfaces the worst account status for collapsed connector rows', () => {
    expect(getWorstAccountStatus([account('connected'), account('failed')])?.label).toBe('failed');
    expect(getWorstAccountStatus([account('syncing'), account('degraded')])?.label).toBe(
      'degraded',
    );
  });
});
