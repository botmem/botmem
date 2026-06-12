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

  it('ignores backfill-style connector cursors only for manual syncs', () => {
    expect(service.shouldIgnoreCursor('whatsapp', false)).toBe(true);
    expect(service.shouldIgnoreCursor('whatsapp', true)).toBe(false);
    expect(service.shouldIgnoreCursor('apple', false)).toBe(false);
    expect(service.shouldIgnoreCursor('apple', true)).toBe(false);
    expect(service.shouldIgnoreCursor('imessage', false)).toBe(false);
    expect(service.shouldIgnoreCursor('imessage', true)).toBe(false);
    expect(service.shouldIgnoreCursor('gmail', false)).toBe(false);
  });

  it('treats Apple bridge connectivity failures as fatal reconnects', () => {
    expect(service.classifyFailure('apple', 'iMessage bridge not connected')).toMatchObject({
      fatal: true,
      accountStatus: 'reconnect_required',
    });
    expect(service.classifyFailure('imessage', 'bridge not running')).toMatchObject({
      fatal: true,
      accountStatus: 'reconnect_required',
    });
  });
});
