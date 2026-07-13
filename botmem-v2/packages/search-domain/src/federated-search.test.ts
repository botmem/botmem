import type { SearchHit, SearchRequest, SearchRequestInput } from '@botmem-v2/contracts';
import { describe, expect, it } from 'vitest';
import { FederatedSearchService } from './federated-search.js';
import type {
  ClockPort,
  DeviceDirectoryPort,
  DeviceSearchPort,
  DeviceTarget,
  HostedSearchPort,
  QueryIdPort,
  RankedLaneResult,
  SearchCandidate,
  SearchLaneContext,
} from './ports.js';

const QUERY_ID = '52b2ecba-3d9a-4c9d-89c8-e06c7916eec1';
const DEVICE_ID = 'df381211-58ea-4558-a36f-a2a3202bc682';
const ACCOUNT_ID = 'ae9af62a-c77a-43f7-b4c3-b8b0dd2b76f7';

class SystemClock implements ClockPort {
  nowMs(): number {
    return Date.now();
  }
}

class FixedQueryIds implements QueryIdPort {
  next(): string {
    return QUERY_ID;
  }
}

function candidate(
  ref: string,
  connector: 'gmail' | 'imessage' | 'whatsapp',
  occurredAt: string,
): SearchCandidate {
  const device = connector !== 'gmail';
  return {
    ref,
    sourceId: ref,
    revision: '1',
    origin: device
      ? { placement: 'device', connector, deviceId: DEVICE_ID }
      : { placement: 'hosted', connector, accountId: ACCOUNT_ID },
    kind: connector === 'gmail' ? 'email' : 'message',
    occurredAt,
    text: `text for ${ref}`,
    participants: [],
    media: [],
    citation: `botmem://memory/${ref}`,
  };
}

function result(...candidates: SearchCandidate[]): RankedLaneResult {
  return { candidates };
}

function service(
  hostedSearch: HostedSearchPort,
  deviceDirectory: DeviceDirectoryPort,
  deviceSearch: DeviceSearchPort,
  deadlines = { hostedDeadlineMs: 100, deviceDeadlineMs: 100 },
): FederatedSearchService {
  return new FederatedSearchService(
    hostedSearch,
    deviceDirectory,
    deviceSearch,
    new SystemClock(),
    new FixedQueryIds(),
    {
      ...deadlines,
      reciprocalRankConstant: 60,
    },
  );
}

const readyDevice: DeviceTarget = {
  deviceId: DEVICE_ID,
  availability: 'ready',
  connectors: ['imessage', 'whatsapp'],
  sources: [
    { connector: 'imessage', availability: 'ready', searchable: true },
    { connector: 'whatsapp', availability: 'ready', searchable: true },
  ],
};

const baseRequest: SearchRequestInput = {
  version: 2,
  query: 'launch',
  limit: 20,
};

describe('FederatedSearchService', () => {
  it('search_whenOnlyLocalSourcesAreRequestedWithoutADevice_returnsOfflinePartial', async () => {
    const hosted: HostedSearchPort = { search: async () => result() };
    const directory: DeviceDirectoryPort = { listSearchTargets: async () => [] };
    const device: DeviceSearchPort = { search: async () => result() };

    const response = await service(hosted, directory, device).search('workspace-1', {
      ...baseRequest,
      connectors: ['imessage'],
    });

    expect(response.items).toEqual([]);
    expect(response.coverage.partial).toBe(true);
    expect(response.coverage.lanes).toEqual([
      expect.objectContaining({
        laneId: 'device-directory',
        status: 'offline',
        reasonCode: 'no_eligible_device',
      }),
    ]);
  });

  it('search_whenHostedAndDeviceAreReady_returnsOneFusedResultSet', async () => {
    const hosted: HostedSearchPort = {
      search: async () => result(candidate('gmail:1', 'gmail', '2026-07-13T10:00:00.000Z')),
    };
    const directory: DeviceDirectoryPort = {
      listSearchTargets: async () => [readyDevice],
    };
    const device: DeviceSearchPort = {
      search: async () => result(candidate('imessage:1', 'imessage', '2026-07-13T11:00:00.000Z')),
    };

    const response = await service(hosted, directory, device).search('workspace-1', baseRequest);

    expect(response.items.map((item: SearchHit) => item.ref)).toEqual(['imessage:1', 'gmail:1']);
    expect(response.coverage.partial).toBe(false);
    expect(response.coverage.lanes.map((lane) => lane.laneId)).toEqual([
      `device:${DEVICE_ID}`,
      'hosted',
    ]);
  });

  it('search_whenOneDeviceConnectorNeedsPermission_queriesReadyConnectorAndDisclosesGap', async () => {
    let routedConnectors: SearchRequest['connectors'];
    const hosted: HostedSearchPort = {
      search: async () => {
        throw new Error('hosted search must not run for local-only connector filters');
      },
    };
    const directory: DeviceDirectoryPort = {
      listSearchTargets: async () => [
        {
          ...readyDevice,
          sources: [
            { connector: 'imessage', availability: 'ready', searchable: true },
            {
              connector: 'whatsapp',
              availability: 'permission_required',
              searchable: false,
              reasonCode: 'full_disk_access_required',
            },
          ],
        },
      ],
    };
    const device: DeviceSearchPort = {
      search: async (_workspaceId, _target, request) => {
        routedConnectors = request.connectors;
        return result(candidate('imessage:1', 'imessage', '2026-07-13T11:00:00.000Z'));
      },
    };

    const response = await service(hosted, directory, device).search('workspace-1', {
      ...baseRequest,
      connectors: ['imessage', 'whatsapp'],
    });

    expect(routedConnectors).toEqual(['imessage']);
    expect(response.items.map((item) => item.ref)).toEqual(['imessage:1']);
    expect(response.coverage.partial).toBe(true);
    expect(response.coverage.lanes).toContainEqual({
      laneId: `device:${DEVICE_ID}:whatsapp`,
      placement: 'device',
      deviceId: DEVICE_ID,
      connector: 'whatsapp',
      status: 'permission_required',
      retryable: false,
      returned: 0,
      tookMs: 0,
      reasonCode: 'full_disk_access_required',
    });
  });

  it('search_whenHostedSemanticRankingIsUnavailable_keepsLexicalResultsAndMarksDegraded', async () => {
    const hosted: HostedSearchPort = {
      search: async () => ({
        ...result(candidate('gmail:1', 'gmail', '2026-07-13T10:00:00.000Z')),
        degradation: { reasonCode: 'embedding_timeout', retryable: true },
      }),
    };
    const directory: DeviceDirectoryPort = { listSearchTargets: async () => [] };
    const device: DeviceSearchPort = { search: async () => result() };

    const response = await service(hosted, directory, device).search('workspace-1', {
      ...baseRequest,
      connectors: ['gmail'],
    });

    expect(response.items.map((item) => item.ref)).toEqual(['gmail:1']);
    expect(response.coverage.partial).toBe(true);
    expect(response.coverage.lanes).toEqual([
      expect.objectContaining({
        laneId: 'hosted',
        status: 'degraded',
        returned: 1,
        retryable: true,
        reasonCode: 'embedding_timeout',
      }),
    ]);
  });

  it('search_whenDeviceIsOffline_returnsHostedResultsAndExplicitPartialCoverage', async () => {
    const hosted: HostedSearchPort = {
      search: async () => result(candidate('gmail:1', 'gmail', '2026-07-13T10:00:00.000Z')),
    };
    const directory: DeviceDirectoryPort = {
      listSearchTargets: async () => [
        { ...readyDevice, availability: 'offline', reasonCode: 'device_disconnected' },
      ],
    };
    const device: DeviceSearchPort = {
      search: async () => {
        throw new Error('must not be called for an offline device');
      },
    };

    const response = await service(hosted, directory, device).search('workspace-1', baseRequest);

    expect(response.items.map((item) => item.ref)).toEqual(['gmail:1']);
    expect(response.coverage.partial).toBe(true);
    expect(response.coverage.lanes).toContainEqual({
      laneId: `device:${DEVICE_ID}`,
      placement: 'device',
      deviceId: DEVICE_ID,
      status: 'offline',
      retryable: true,
      returned: 0,
      tookMs: 0,
      reasonCode: 'device_disconnected',
    });
  });

  it('search_whenDeviceExceedsDeadline_doesNotSuppressHostedResults', async () => {
    const hosted: HostedSearchPort = {
      search: async () => result(candidate('gmail:1', 'gmail', '2026-07-13T10:00:00.000Z')),
    };
    const directory: DeviceDirectoryPort = {
      listSearchTargets: async () => [readyDevice],
    };
    const device: DeviceSearchPort = {
      search: async (_workspaceId, _device, _request, context) =>
        new Promise<RankedLaneResult>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(result()), { once: true });
        }),
    };

    const response = await service(hosted, directory, device, {
      hostedDeadlineMs: 50,
      deviceDeadlineMs: 5,
    }).search('workspace-1', baseRequest);

    expect(response.items.map((item) => item.ref)).toEqual(['gmail:1']);
    expect(response.coverage.lanes.find((lane) => lane.placement === 'device')?.status).toBe(
      'timed_out',
    );
  });

  it('search_whenSameReferenceAppearsInTwoLanes_deduplicatesAndRewardsAgreement', async () => {
    const shared = candidate('imessage:shared', 'imessage', '2026-07-13T10:00:00.000Z');
    const hosted: HostedSearchPort = {
      search: async () => result(shared, candidate('gmail:2', 'gmail', '2026-07-13T12:00:00.000Z')),
    };
    const directory: DeviceDirectoryPort = {
      listSearchTargets: async () => [readyDevice],
    };
    const device: DeviceSearchPort = {
      search: async () =>
        result(shared, candidate('imessage:2', 'imessage', '2026-07-13T11:00:00.000Z')),
    };

    const response = await service(hosted, directory, device).search('workspace-1', baseRequest);

    expect(response.items.map((item) => item.ref)).toEqual([
      'imessage:shared',
      'gmail:2',
      'imessage:2',
    ]);
    expect(response.items[0]?.ranking.matchedLanes).toEqual([`device:${DEVICE_ID}`, 'hosted']);
  });

  it('search_whenOnlyHostedConnectorIsRequested_doesNotListOrSearchDevices', async () => {
    let directoryCalls = 0;
    const hosted: HostedSearchPort = {
      search: async (_workspaceId, request: SearchRequest) => {
        expect(request.connectors).toEqual(['gmail']);
        return result(candidate('gmail:1', 'gmail', '2026-07-13T10:00:00.000Z'));
      },
    };
    const directory: DeviceDirectoryPort = {
      listSearchTargets: async () => {
        directoryCalls += 1;
        return [readyDevice];
      },
    };
    const device: DeviceSearchPort = {
      search: async () => result(),
    };

    const response = await service(hosted, directory, device).search('workspace-1', {
      ...baseRequest,
      connectors: ['gmail'],
    });

    expect(directoryCalls).toBe(0);
    expect(response.coverage.lanes.map((lane) => lane.laneId)).toEqual(['hosted']);
  });

  it('search_whenBothLanesRun_startsHostedBeforeDeviceDiscoveryCompletes', async () => {
    const events: string[] = [];
    let releaseDirectory: (() => void) | undefined;
    const directoryReady = new Promise<void>((resolve) => {
      releaseDirectory = resolve;
    });
    const hosted: HostedSearchPort = {
      search: async () => {
        events.push('hosted-started');
        return result();
      },
    };
    const directory: DeviceDirectoryPort = {
      listSearchTargets: async () => {
        events.push('directory-started');
        await directoryReady;
        return [];
      },
    };
    const device: DeviceSearchPort = {
      search: async (
        _workspaceId: string,
        _target: DeviceTarget,
        _request: SearchRequest,
        _context: SearchLaneContext,
      ) => result(),
    };

    const pending = service(hosted, directory, device).search('workspace-1', baseRequest);
    await Promise.resolve();
    releaseDirectory?.();
    await pending;

    expect(events).toEqual(['hosted-started', 'directory-started']);
  });

  it('search_whenDeviceDirectoryExceedsDeadline_returnsHostedPartialWithoutHanging', async () => {
    let directoryAborted = false;
    const hosted: HostedSearchPort = {
      search: async () => result(candidate('gmail:1', 'gmail', '2026-07-13T10:00:00.000Z')),
    };
    const directory: DeviceDirectoryPort = {
      listSearchTargets: async (_workspaceId, signal) =>
        new Promise<readonly DeviceTarget[]>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              directoryAborted = true;
              resolve([]);
            },
            { once: true },
          );
        }),
    };
    const device: DeviceSearchPort = {
      search: async () => result(),
    };

    const response = await new FederatedSearchService(
      hosted,
      directory,
      device,
      new SystemClock(),
      new FixedQueryIds(),
      {
        hostedDeadlineMs: 50,
        deviceDeadlineMs: 50,
        deviceDirectoryDeadlineMs: 5,
        reciprocalRankConstant: 60,
      },
    ).search('workspace-1', baseRequest);

    expect(response.items.map((item) => item.ref)).toEqual(['gmail:1']);
    expect(response.coverage.partial).toBe(true);
    expect(response.coverage.lanes).toContainEqual({
      laneId: 'device-directory',
      placement: 'device',
      status: 'timed_out',
      retryable: true,
      returned: 0,
      tookMs: 0,
      reasonCode: 'device_directory_deadline_exceeded',
    });
    expect(directoryAborted).toBe(true);
  });

  it('search_whenHostedFailsAndDeviceSucceeds_returnsDevicePartial', async () => {
    const hosted: HostedSearchPort = {
      search: async () => {
        throw new Error('postgres unavailable');
      },
    };
    const directory: DeviceDirectoryPort = {
      listSearchTargets: async () => [readyDevice],
    };
    const device: DeviceSearchPort = {
      search: async () => result(candidate('whatsapp:1', 'whatsapp', '2026-07-13T11:00:00.000Z')),
    };

    const response = await service(hosted, directory, device).search('workspace-1', baseRequest);

    expect(response.items.map((item) => item.ref)).toEqual(['whatsapp:1']);
    expect(response.coverage.partial).toBe(true);
    expect(response.coverage.lanes.find((lane) => lane.laneId === 'hosted')?.status).toBe('failed');
  });

  it('search_whenOneLaneReturnsMalformedCandidate_keepsHealthyLaneAndMarksFailure', async () => {
    const malformed = {
      ...candidate('gmail:invalid', 'gmail', '2026-07-13T10:00:00.000Z'),
      kind: 'message',
    } as unknown as SearchCandidate;
    const hosted: HostedSearchPort = {
      search: async () => result(malformed),
    };
    const directory: DeviceDirectoryPort = {
      listSearchTargets: async () => [readyDevice],
    };
    const device: DeviceSearchPort = {
      search: async () =>
        result(candidate('imessage:valid', 'imessage', '2026-07-13T11:00:00.000Z')),
    };

    const response = await service(hosted, directory, device).search('workspace-1', baseRequest);

    expect(response.items.map((item) => item.ref)).toEqual(['imessage:valid']);
    expect(response.coverage.partial).toBe(true);
    expect(response.coverage.lanes.find((lane) => lane.laneId === 'hosted')).toMatchObject({
      status: 'failed',
      reasonCode: 'lane_failed',
    });
  });
});
