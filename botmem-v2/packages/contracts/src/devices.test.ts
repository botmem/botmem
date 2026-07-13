import { describe, expect, it } from 'vitest';
import { DeviceSummarySchema } from './devices.js';

describe('device status contracts', () => {
  it('DeviceSummarySchema_rejectsUndeclaredOrRemoteSources', () => {
    expect(() =>
      DeviceSummarySchema.parse({
        deviceId: '10000000-0000-4000-8000-000000000001',
        displayName: 'Amr MacBook',
        state: 'offline',
        connectors: ['imessage'],
        sources: [{ connector: 'whatsapp', readiness: 'disconnected', searchable: false }],
      }),
    ).toThrow();
    expect(() =>
      DeviceSummarySchema.parse({
        deviceId: '10000000-0000-4000-8000-000000000001',
        displayName: 'Amr MacBook',
        state: 'offline',
        connectors: ['imessage'],
        sources: [{ connector: 'gmail', readiness: 'disconnected', searchable: false }],
      }),
    ).toThrow();
  });

  it('DeviceSummarySchema_requiresHeartbeatEvidenceForOnline', () => {
    expect(() =>
      DeviceSummarySchema.parse({
        deviceId: '10000000-0000-4000-8000-000000000001',
        displayName: 'Amr MacBook',
        state: 'online',
        connectors: ['imessage'],
        sources: [],
      }),
    ).toThrow();
  });
});
