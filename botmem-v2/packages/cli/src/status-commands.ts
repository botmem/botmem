import {
  ConnectionListResponseSchema,
  DeviceListResponseSchema,
  parseWorkspaceId,
  type ConnectionListResponse,
  type DeviceListResponse,
} from '@botmem-v2/contracts';
import type { ConnectionsApplicationService, DevicesApplicationService } from '@botmem-v2/sdk';
import { CliUsageError, type CliIo } from './search-command.js';

export interface StatusCommandDependencies {
  readonly connections: ConnectionsApplicationService;
  readonly devices: DevicesApplicationService;
  readonly io: CliIo;
}

export async function runConnectionsListCommand(
  argv: readonly string[],
  dependencies: Pick<StatusCommandDependencies, 'connections' | 'io'>,
): Promise<ConnectionListResponse> {
  const { workspaceId, json } = parseStatusArguments(argv, 'connections', 'list');
  const response = ConnectionListResponseSchema.parse(
    await dependencies.connections.listConnections(workspaceId),
  );
  dependencies.io.writeStdout(
    json
      ? `${JSON.stringify(response)}\n`
      : renderList(
          response.items.map((item) => `${item.id} ${item.connector} ${item.state}`),
        ),
  );
  return response;
}

export async function runDevicesStatusCommand(
  argv: readonly string[],
  dependencies: Pick<StatusCommandDependencies, 'devices' | 'io'>,
): Promise<DeviceListResponse> {
  const { workspaceId, json } = parseStatusArguments(argv, 'devices', 'status');
  const response = DeviceListResponseSchema.parse(
    await dependencies.devices.listDevices(workspaceId),
  );
  dependencies.io.writeStdout(
    json
      ? `${JSON.stringify(response)}\n`
      : renderList(response.items.map((item) => `${item.deviceId} ${item.displayName} ${item.state}`)),
  );
  return response;
}

function renderList(rows: readonly string[]): string {
  return `${rows.length === 0 ? '(none)' : rows.join('\n')}\n`;
}

function parseStatusArguments(
  argv: readonly string[],
  noun: 'connections' | 'devices',
  verb: 'list' | 'status',
): { workspaceId: string; json: boolean } {
  if (argv[0] !== noun || argv[1] !== verb) {
    throw new CliUsageError(`expected the ${noun} ${verb} command`);
  }
  let workspace: string | undefined;
  let jsonSeen = false;
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') {
      if (jsonSeen) throw new CliUsageError('--json may be provided once');
      jsonSeen = true;
      continue;
    }
    if (flag !== '--workspace') throw new CliUsageError(`unknown option: ${flag ?? ''}`);
    if (workspace) throw new CliUsageError('--workspace may be provided once');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new CliUsageError('missing value for --workspace');
    }
    workspace = value;
    index += 1;
  }
  if (!workspace) throw new CliUsageError('--workspace is required');
  return { workspaceId: parseWorkspaceId(workspace), json: jsonSeen };
}
