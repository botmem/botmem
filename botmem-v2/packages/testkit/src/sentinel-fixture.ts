import {
  SourceStatusSchema,
  type Connector,
  type SearchRequest,
  type SourceStatus,
} from '@botmem-v2/contracts';
import {
  FederatedSearchService,
  type ClockPort,
  type DeviceAvailability,
  type DeviceDirectoryPort,
  type DeviceSearchPort,
  type HostedSearchPort,
  type QueryIdPort,
  type RankedLaneResult,
  type SearchCandidate,
} from '@botmem-v2/search-domain';

export const SENTINEL_WORKSPACE_ID = '8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf';
export const SENTINEL_ACCESS_TOKEN = 'sentinel-access-token';
export const SENTINEL_DEVICE_ID = 'df381211-58ea-4558-a36f-a2a3202bc682';
export const SENTINEL_ACCOUNT_ID = 'ae9af62a-c77a-43f7-b4c3-b8b0dd2b76f7';
export const SENTINEL_QUERY_ID = '52b2ecba-3d9a-4c9d-89c8-e06c7916eec1';
export const SENTINEL_QUERY = 'BOTMEM-SENTINEL-2026';
const CHECKPOINT_AT = '2026-07-13T12:00:00.000Z';
const PROBE_AT = '2026-07-13T12:00:01.000Z';

export interface SentinelFixture {
  readonly service: FederatedSearchService;
  readonly statuses: readonly SourceStatus[];
}

export function createSentinelFixture(
  deviceAvailability: DeviceAvailability = 'ready',
): SentinelFixture {
  const statuses = sourceStatuses(deviceAvailability);
  const hostedCandidates = [candidate('gmail', 'gmail:sentinel', '2026-07-13T11:00:00.000Z')];
  const deviceCandidates = [
    candidate('imessage', 'imessage:sentinel', '2026-07-13T12:00:00.000Z'),
    candidate('whatsapp', 'whatsapp:sentinel', '2026-07-13T10:00:00.000Z'),
  ];
  const hosted: HostedSearchPort = {
    search: async (workspaceId, request) => {
      assertWorkspace(workspaceId);
      return result(filter(hostedCandidates, request));
    },
  };
  const directory: DeviceDirectoryPort = {
    listSearchTargets: async (workspaceId) => {
      assertWorkspace(workspaceId);
      return [
        {
          deviceId: SENTINEL_DEVICE_ID,
          availability: deviceAvailability,
          connectors: ['imessage', 'whatsapp'],
          sources: (['imessage', 'whatsapp'] as const).map((connector) => ({
            connector,
            availability: deviceAvailability,
            searchable: deviceAvailability === 'ready',
            ...(deviceAvailability === 'ready'
              ? {}
              : { reasonCode: 'device_disconnected' }),
          })),
          ...(deviceAvailability === 'ready' ? {} : { reasonCode: 'device_disconnected' }),
        },
      ];
    },
  };
  const device: DeviceSearchPort = {
    search: async (workspaceId, _target, request) => {
      assertWorkspace(workspaceId);
      return result(filter(deviceCandidates, request));
    },
  };
  const clock: ClockPort = { nowMs: () => 1_721_000_000_000 };
  const queryIds: QueryIdPort = { next: () => SENTINEL_QUERY_ID };
  return {
    service: new FederatedSearchService(hosted, directory, device, clock, queryIds),
    statuses,
  };
}

function sourceStatuses(deviceAvailability: DeviceAvailability): readonly SourceStatus[] {
  const gmail = readyStatus('gmail', 1);
  if (deviceAvailability === 'ready') {
    return [gmail, readyStatus('imessage', 1), readyStatus('whatsapp', 1)];
  }
  return [
    gmail,
    SourceStatusSchema.parse({
      connector: 'imessage',
      readiness: 'degraded',
      searchable: false,
      indexedCount: 1,
      checkpointAt: CHECKPOINT_AT,
      lastProbeAt: PROBE_AT,
      reasonCode: 'device_disconnected',
    }),
    SourceStatusSchema.parse({
      connector: 'whatsapp',
      readiness: 'degraded',
      searchable: false,
      indexedCount: 1,
      checkpointAt: CHECKPOINT_AT,
      lastProbeAt: PROBE_AT,
      reasonCode: 'device_disconnected',
    }),
  ];
}

function readyStatus(connector: Connector, indexedCount: number): SourceStatus {
  return SourceStatusSchema.parse({
    connector,
    readiness: 'ready',
    ...(connector === 'imessage' || connector === 'whatsapp' ? { detail: 'ready' } : {}),
    searchable: true,
    indexedCount,
    checkpointAt: CHECKPOINT_AT,
    lastProbeAt: PROBE_AT,
  });
}

function candidate(
  connector: 'gmail' | 'imessage' | 'whatsapp',
  ref: string,
  occurredAt: string,
): SearchCandidate {
  const onDevice = connector !== 'gmail';
  return {
    ref,
    sourceId: ref,
    revision: '1',
    origin: onDevice
      ? { placement: 'device', connector, deviceId: SENTINEL_DEVICE_ID }
      : { placement: 'hosted', connector, accountId: SENTINEL_ACCOUNT_ID },
    kind: connector === 'gmail' ? 'email' : 'message',
    occurredAt,
    title: `${connector} sentinel`,
    text: `${SENTINEL_QUERY} deterministic cross-surface fixture`,
    participants: [],
    media: [],
    citation: `botmem://memory/${ref}`,
  };
}

function filter(
  candidates: readonly SearchCandidate[],
  request: SearchRequest,
): readonly SearchCandidate[] {
  const query = request.query.toLocaleLowerCase();
  return candidates.filter((item) => {
    if (!`${item.title ?? ''} ${item.text}`.toLocaleLowerCase().includes(query)) return false;
    if (request.connectors && !request.connectors.includes(item.origin.connector)) return false;
    if (request.kinds && !request.kinds.includes(item.kind)) return false;
    if (request.from && item.occurredAt && item.occurredAt < request.from) return false;
    if (request.to && item.occurredAt && item.occurredAt > request.to) return false;
    return true;
  });
}

function result(candidates: readonly SearchCandidate[]): RankedLaneResult {
  return { candidates };
}

function assertWorkspace(workspaceId: string): void {
  if (workspaceId !== SENTINEL_WORKSPACE_ID) throw new Error('fixture workspace denied');
}
