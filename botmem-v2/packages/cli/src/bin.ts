#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import {
  ConnectionsApiClient,
  DevicesApiClient,
  FetchHttpTransport,
  SearchApiClient,
} from '@botmem-v2/sdk';
import { runSearchCommand } from './search-command.js';
import { runConnectionsListCommand, runDevicesStatusCommand } from './status-commands.js';

const argv = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  readonly version: string;
};

if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
  process.stdout.write(`${manifest.version}\n`);
} else if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
  process.stdout.write(
    [
      'botmem search --workspace <uuid> --query <text> [--json]',
      'botmem connections list --workspace <uuid> [--json]',
      'botmem devices status --workspace <uuid> [--json]',
      '',
      'Environment: BOTMEM_API_URL and BOTMEM_ACCESS_TOKEN',
      'PAT scopes: search requires botmem:search; status commands require their read scope.',
      '',
    ].join('\n'),
  );
} else {
  const baseUrl = process.env['BOTMEM_API_URL'];
  const accessToken = process.env['BOTMEM_ACCESS_TOKEN'];

  if (!baseUrl || !accessToken) {
    process.stderr.write('BOTMEM_API_URL and BOTMEM_ACCESS_TOKEN are required\n');
    process.exitCode = 2;
  } else {
    const transport = new FetchHttpTransport({ baseUrl });
    const authentication = { kind: 'bearer' as const, accessToken };
    const search = new SearchApiClient({ transport, authentication });
    const connections = new ConnectionsApiClient({ transport, authentication });
    const devices = new DevicesApiClient({ transport, authentication });
    const io = { writeStdout: (value: string) => process.stdout.write(value) };
    try {
      if (argv[0] === 'search') {
        await runSearchCommand(argv, { search, io });
      } else if (argv[0] === 'connections') {
        await runConnectionsListCommand(argv, { connections, io });
      } else if (argv[0] === 'devices') {
        await runDevicesStatusCommand(argv, { devices, io });
      } else {
        throw new Error('expected search, connections list, or devices status');
      }
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : 'Command failed'}\n`);
      process.exitCode = 1;
    }
  }
}
