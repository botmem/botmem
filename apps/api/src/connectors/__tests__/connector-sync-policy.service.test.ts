import { describe, expect, it } from 'vitest';
import { ConnectorSyncPolicyService } from '../connector-sync-policy.service';

describe('ConnectorSyncPolicyService', () => {
  const service = new ConnectorSyncPolicyService();

  it('marks auth/session failures as reconnect required', () => {
    expect(
      service.classifyFailure('whatsapp', 'session files missing, please re-scan QR'),
    ).toMatchObject({
      accountStatus: 'reconnect_required',
      fatal: true,
      recoverableRuntimeFailure: false,
    });
  });

  it('keeps transient WhatsApp runtime disconnects recoverable', () => {
    expect(service.classifyFailure('whatsapp', 'Connection lost during sync')).toMatchObject({
      accountStatus: 'failed',
      fatal: false,
      recoverableRuntimeFailure: true,
    });
  });

  it('ignores WhatsApp cursors only for manual syncs', () => {
    expect(service.shouldIgnoreCursor('whatsapp', false)).toBe(true);
    expect(service.shouldIgnoreCursor('whatsapp', true)).toBe(false);
    expect(service.shouldIgnoreCursor('gmail', false)).toBe(false);
  });
});
