import type { ConnectionsApplicationService, DevicesApplicationService } from '@botmem-v2/sdk';
import { describe, expect, it } from 'vitest';
import { runConnectionsListCommand, runDevicesStatusCommand } from './status-commands.js';

const WORKSPACE_ID = '8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf';

describe('status CLI commands', () => {
  it('connectionsList_forwardsWorkspaceAndWritesCanonicalJson', async () => {
    let received: string | undefined;
    let output = '';
    const connections = {
      listConnections: async (workspaceId: string) => {
        received = workspaceId;
        return { version: 2 as const, items: [] };
      },
    } as ConnectionsApplicationService;

    await runConnectionsListCommand(
      ['connections', 'list', '--workspace', WORKSPACE_ID, '--json'],
      { connections, io: { writeStdout: (value) => (output += value) } },
    );

    expect(received).toBe(WORKSPACE_ID);
    expect(output).toBe('{"version":2,"items":[]}\n');
  });

  it('devicesStatus_rejectsUnknownOptionsBeforeCallingTheApi', async () => {
    let called = false;
    const devices: DevicesApplicationService = {
      listDevices: async () => {
        called = true;
        return { version: 2, items: [] };
      },
    };

    await expect(
      runDevicesStatusCommand(['devices', 'status', '--workspace', WORKSPACE_ID, '--watch'], {
        devices,
        io: { writeStdout: () => undefined },
      }),
    ).rejects.toThrow(/unknown option/);
    expect(called).toBe(false);
  });
});
