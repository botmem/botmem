import {
  parseSearchRequest,
  parseSearchResponse,
  parseWorkspaceId,
  type Connector,
  type MemoryKind,
  type SearchRequestInput,
  type SearchResponse,
} from '@botmem-v2/contracts';
import type { SearchApplicationService } from '@botmem-v2/sdk';

export interface CliIo {
  writeStdout(value: string): void;
}

export interface SearchCommandDependencies {
  readonly search: SearchApplicationService;
  readonly io: CliIo;
}

/** Executes `search --workspace ... --query ... --json` without private filtering. */
export async function runSearchCommand(
  argv: readonly string[],
  dependencies: SearchCommandDependencies,
): Promise<SearchResponse> {
  const options = parseArguments(argv);
  const response = await dependencies.search.search(options.workspaceId, options.request);
  const validated = parseSearchResponse(response);
  dependencies.io.writeStdout(options.json ? renderSearchJson(validated) : renderSearchText(validated));
  return validated;
}

export function renderSearchJson(response: SearchResponse): string {
  return `${JSON.stringify(response)}\n`;
}

export function renderSearchText(response: SearchResponse): string {
  const lines: string[] = [];
  lines.push(`${response.found} result${response.found === 1 ? '' : 's'} in ${response.tookMs}ms`);
  for (const hit of response.items) {
    const when = hit.occurredAt ?? 'unknown time';
    const label = hit.title ?? hit.text.split('\n', 1)[0] ?? '';
    lines.push(`${hit.ranking.rank}. [${hit.origin.connector}] ${when} ${label}`.trimEnd());
  }
  for (const lane of response.coverage.lanes) {
    if (lane.status !== 'complete') {
      lines.push(
        `! lane ${lane.laneId} (${lane.placement}) ${lane.status}${lane.reasonCode ? `: ${lane.reasonCode}` : ''}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function parseArguments(argv: readonly string[]): {
  workspaceId: string;
  request: SearchRequestInput;
  json: boolean;
} {
  if (argv[0] !== 'search') throw new CliUsageError('expected the search command');
  const values = new Map<string, string[]>();
  const valueFlags = new Set([
    '--workspace',
    '--query',
    '--limit',
    '--connector',
    '--kind',
    '--from',
    '--to',
    '--participant-id',
    '--authored-by-me',
    '--account-id',
    '--device-id',
  ]);
  let jsonSeen = false;
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') {
      if (jsonSeen) throw new CliUsageError('--json may be provided once');
      jsonSeen = true;
      continue;
    }
    if (!flag?.startsWith('--')) throw new CliUsageError(`unexpected argument: ${flag ?? ''}`);
    if (!valueFlags.has(flag)) throw new CliUsageError(`unknown option: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new CliUsageError(`missing value for ${flag}`);
    const previous = values.get(flag) ?? [];
    previous.push(value);
    values.set(flag, previous);
    index += 1;
  }

  const workspaceId = parseWorkspaceId(one(values, '--workspace'));
  const query = one(values, '--query');
  const limitValue = optionalOne(values, '--limit');
  const connectors = values.get('--connector') as Connector[] | undefined;
  const kinds = values.get('--kind') as MemoryKind[] | undefined;
  const from = optionalOne(values, '--from');
  const to = optionalOne(values, '--to');
  const participantId = optionalOne(values, '--participant-id');
  const authoredByMe = optionalOne(values, '--authored-by-me');
  const accountIds = values.get('--account-id');
  const deviceIds = values.get('--device-id');
  const request = parseSearchRequest({
    version: 2,
    query,
    ...(limitValue ? { limit: parseLimit(limitValue) } : {}),
    ...(connectors ? { connectors } : {}),
    ...(kinds ? { kinds } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(participantId ? { participantId } : {}),
    ...(authoredByMe ? { authoredByMe: parseBoolean(authoredByMe, '--authored-by-me') } : {}),
    ...(accountIds ? { accountIds } : {}),
    ...(deviceIds ? { deviceIds } : {}),
  });
  return { workspaceId, request, json: jsonSeen };
}

function one(values: ReadonlyMap<string, readonly string[]>, flag: string): string {
  const value = optionalOne(values, flag);
  if (!value) throw new CliUsageError(`${flag} is required`);
  return value;
}

function optionalOne(
  values: ReadonlyMap<string, readonly string[]>,
  flag: string,
): string | undefined {
  const entries = values.get(flag);
  if (!entries) return undefined;
  if (entries.length !== 1) throw new CliUsageError(`${flag} may be provided once`);
  return entries[0];
}

function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit)) throw new CliUsageError('--limit must be an integer');
  return limit;
}

function parseBoolean(value: string, flag: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new CliUsageError(`${flag} must be true or false`);
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}
