import type { SourceStatus } from '@botmem-v2/contracts';
import { describe, expect, it } from 'vitest';
import type { DeviceSnapshot } from './domain.js';
import type { DeviceRegistryPort } from './ports.js';
import {
  CombinedSourceStatusReader,
  DeviceSourceStatusReader,
  type DeviceSourceStatusDirectoryPort,
  type SourceStatusReaderPort,
} from './source-status.js';

const WORKSPACE_ID = '20000000-0000-4000-8000-000000000001';
const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const DEVICE_ID = '30000000-0000-4000-8000-000000000001';

const device: DeviceSnapshot = {
  tenantId: TENANT_ID,
  workspaceId: WORKSPACE_ID,
  deviceId: DEVICE_ID,
  displayName: 'Mac',
  keyId: 'key',
  publicKeyBase64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  connectors: ['imessage'],
  status: 'active',
  credentialVersion: 1,
  createdAt: '2026-07-13T09:00:00.000Z',
  updatedAt: '2026-07-13T09:00:00.000Z',
};

describe('device source status composition', () => {
  it('statusReader_filtersOwnershipAndCombinedReaderReturnsHostedPlusDevice', async () => {
    const devices: DeviceRegistryPort = {
      create: async () => undefined,
      get: async () => device,
      listForWorkspace: async () => [device],
      save: async () => undefined,
    };
    const statuses: DeviceSourceStatusDirectoryPort = {
      list: async () => [
        {
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          deviceId: DEVICE_ID,
          expiresAtMs: 2_000,
          sources: [ready('imessage')],
        },
        {
          tenantId: '10000000-0000-4000-8000-000000000002',
          workspaceId: WORKSPACE_ID,
          deviceId: DEVICE_ID,
          expiresAtMs: 2_000,
          sources: [ready('whatsapp')],
        },
      ],
    };
    const deviceReader = new DeviceSourceStatusReader(devices, statuses, () => 1_000);
    const hosted: SourceStatusReaderPort = {
      list: async () => [
        {
          connector: 'gmail',
          readiness: 'disconnected',
          searchable: false,
          indexedCount: 0,
        },
      ],
    };
    const combined = new CombinedSourceStatusReader(hosted, deviceReader);
    const result = await combined.list(WORKSPACE_ID, new AbortController().signal);
    expect(result.map((status) => status.connector)).toEqual(['gmail', 'imessage']);
    expect(result[1]).toEqual(ready('imessage'));
  });
});

function ready(connector: 'imessage' | 'whatsapp'): SourceStatus {
  return {
    connector,
    readiness: 'ready',
    detail: 'ready',
    searchable: true,
    indexedCount: 10,
    checkpointAt: '2026-07-13T09:30:00.000Z',
    lastProbeAt: '2026-07-13T09:31:00.000Z',
  };
}
