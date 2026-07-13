import {
  SearchCandidateSchema,
  SearchResponseSchema,
  parseSearchRequest,
  type Connector,
  type SearchLaneCoverage,
  type SearchLaneStatus,
  type SearchRequestInput,
  type SearchResponse,
} from '@botmem-v2/contracts';
import type {
  ClockPort,
  DeviceDirectoryPort,
  DeviceSearchPort,
  DeviceTarget,
  HostedSearchPort,
  QueryIdPort,
  RankedLaneResult,
  SearchCandidate,
} from './ports.js';

const HOSTED_CONNECTORS = new Set<Connector>(['gmail', 'outlook', 'owntracks']);
const DEVICE_CONNECTORS = new Set<Connector>(['imessage', 'whatsapp']);

interface FederatedSearchOptions {
  readonly hostedDeadlineMs: number;
  readonly deviceDeadlineMs: number;
  readonly deviceDirectoryDeadlineMs?: number;
  readonly reciprocalRankConstant: number;
}

interface CompleteLane {
  readonly coverage: SearchLaneCoverage;
  readonly result: RankedLaneResult;
}

interface UnavailableLane {
  readonly coverage: SearchLaneCoverage;
}

type LaneOutcome = CompleteLane | UnavailableLane;

interface LaneDescriptor {
  readonly laneId: string;
  readonly placement: 'hosted' | 'device';
  readonly deviceId?: string;
}

export class FederatedSearchService {
  constructor(
    private readonly hostedSearch: HostedSearchPort,
    private readonly deviceDirectory: DeviceDirectoryPort,
    private readonly deviceSearch: DeviceSearchPort,
    private readonly clock: ClockPort,
    private readonly queryIds: QueryIdPort,
    private readonly options: FederatedSearchOptions = {
      hostedDeadlineMs: 500,
      deviceDeadlineMs: 750,
      reciprocalRankConstant: 60,
    },
  ) {
    if (
      options.hostedDeadlineMs <= 0 ||
      options.deviceDeadlineMs <= 0 ||
      (options.deviceDirectoryDeadlineMs !== undefined && options.deviceDirectoryDeadlineMs <= 0)
    ) {
      throw new RangeError('search lane deadlines must be positive');
    }
    if (options.reciprocalRankConstant <= 0) {
      throw new RangeError('reciprocal rank constant must be positive');
    }
  }

  async search(workspaceId: string, input: SearchRequestInput): Promise<SearchResponse> {
    const startedAt = this.clock.nowMs();
    const request = parseSearchRequest(input);
    const queryId = this.queryIds.next();
    const outcomes: Promise<LaneOutcome>[] = [];
    const placements = this.resolvePlacements(request);

    if (placements.hosted) {
      outcomes.push(
        this.executeLane(
          {
            laneId: 'hosted',
            placement: 'hosted',
          },
          this.options.hostedDeadlineMs,
          (signal) => this.hostedSearch.search(workspaceId, request, { queryId, signal }),
        ),
      );
    }

    if (placements.device) {
      try {
        const devices = await this.withDeadline(
          (signal) => this.deviceDirectory.listSearchTargets(workspaceId, signal),
          this.options.deviceDirectoryDeadlineMs ?? this.options.deviceDeadlineMs,
        );
        const eligibleDevices = this.filterDevices(devices, request.deviceIds, request.connectors);
        if (eligibleDevices.length === 0) {
          outcomes.push(
            Promise.resolve({
              coverage: {
                laneId: 'device-directory',
                placement: 'device',
                status: 'offline',
                retryable: true,
                returned: 0,
                tookMs: 0,
                reasonCode: request.deviceIds
                  ? 'requested_device_unavailable'
                  : 'no_eligible_device',
              },
            }),
          );
        }
        for (const device of eligibleDevices) {
          const laneId = `device:${device.deviceId}`;
          if (device.availability !== 'ready') {
            outcomes.push(Promise.resolve(this.unavailableDevice(device)));
            continue;
          }
          outcomes.push(
            this.executeLane(
              {
                laneId,
                placement: 'device',
                deviceId: device.deviceId,
              },
              this.options.deviceDeadlineMs,
              (signal) =>
                this.deviceSearch.search(workspaceId, device, request, {
                  queryId,
                  signal,
                }),
            ),
          );
        }
      } catch (error) {
        const timedOut = error instanceof LaneTimeoutError;
        outcomes.push(
          Promise.resolve({
            coverage: {
              laneId: 'device-directory',
              placement: 'device',
              status: timedOut ? 'timed_out' : 'failed',
              retryable: true,
              returned: 0,
              tookMs: 0,
              reasonCode: timedOut
                ? 'device_directory_deadline_exceeded'
                : 'device_directory_unavailable',
            },
          }),
        );
      }
    }

    const settled = await Promise.all(outcomes);
    const ordered = settled.sort((left, right) =>
      left.coverage.laneId.localeCompare(right.coverage.laneId),
    );
    const complete = ordered.filter((lane): lane is CompleteLane => 'result' in lane);
    const fused = this.fusePage(complete, request.limit);
    const coverage = ordered.map((lane) => lane.coverage);
    const response: SearchResponse = {
      version: 2,
      queryId,
      items: fused.items,
      coverage: {
        partial: coverage.some((lane) => lane.status !== 'complete'),
        lanes: coverage,
      },
      found: fused.found,
      tookMs: this.elapsedSince(startedAt),
    };

    return SearchResponseSchema.parse(response);
  }

  private resolvePlacements(request: ReturnType<typeof parseSearchRequest>): {
    hosted: boolean;
    device: boolean;
  } {
    const connectorFilter = request.connectors;
    const connectorAllowsHosted =
      !connectorFilter || connectorFilter.some((connector) => HOSTED_CONNECTORS.has(connector));
    const connectorAllowsDevice =
      !connectorFilter || connectorFilter.some((connector) => DEVICE_CONNECTORS.has(connector));
    const kindAllowsHosted =
      !request.kinds || request.kinds.some((kind) => kind === 'email' || kind === 'location');
    const kindAllowsDevice = !request.kinds || request.kinds.includes('message');
    const placementScoped = Boolean(request.accountIds || request.deviceIds);

    return {
      hosted:
        connectorAllowsHosted &&
        kindAllowsHosted &&
        (!placementScoped || Boolean(request.accountIds)),
      device:
        connectorAllowsDevice &&
        kindAllowsDevice &&
        (!placementScoped || Boolean(request.deviceIds)),
    };
  }

  private filterDevices(
    devices: readonly DeviceTarget[],
    requestedDeviceIds: readonly string[] | undefined,
    requestedConnectors: readonly Connector[] | undefined,
  ): readonly DeviceTarget[] {
    const requestedLocalConnectors = requestedConnectors?.filter((connector) =>
      DEVICE_CONNECTORS.has(connector),
    );
    return devices.filter((device) => {
      if (requestedDeviceIds && !requestedDeviceIds.includes(device.deviceId)) return false;
      if (!requestedLocalConnectors) return true;
      return device.connectors.some((connector) => requestedLocalConnectors.includes(connector));
    });
  }

  private unavailableDevice(device: DeviceTarget): UnavailableLane {
    const status: SearchLaneStatus =
      device.availability === 'ready' ? 'failed' : device.availability;
    return {
      coverage: {
        laneId: `device:${device.deviceId}`,
        placement: 'device',
        deviceId: device.deviceId,
        status,
        retryable: status !== 'permission_required',
        returned: 0,
        tookMs: 0,
        ...(device.reasonCode ? { reasonCode: device.reasonCode } : {}),
      },
    };
  }

  private async executeLane(
    lane: LaneDescriptor,
    deadlineMs: number,
    operation: (signal: AbortSignal) => Promise<RankedLaneResult>,
  ): Promise<LaneOutcome> {
    const startedAt = this.clock.nowMs();
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new LaneTimeoutError());
      }, deadlineMs);
    });

    try {
      const result = await Promise.race([operation(controller.signal), timeout]);
      const validated: RankedLaneResult = {
        candidates: result.candidates.map((candidate) => SearchCandidateSchema.parse(candidate)),
        ...(result.degradation ? { degradation: result.degradation } : {}),
      };
      const degraded = validated.degradation;
      return {
        coverage: {
          ...lane,
          status: degraded ? 'degraded' : 'complete',
          retryable: degraded?.retryable ?? false,
          returned: validated.candidates.length,
          tookMs: this.elapsedSince(startedAt),
          ...(degraded ? { reasonCode: degraded.reasonCode } : {}),
        },
        result: validated,
      };
    } catch (error) {
      const timedOut = error instanceof LaneTimeoutError;
      return {
        coverage: {
          ...lane,
          status: timedOut ? 'timed_out' : 'failed',
          retryable: true,
          returned: 0,
          tookMs: this.elapsedSince(startedAt),
          reasonCode: timedOut ? 'lane_deadline_exceeded' : 'lane_failed',
        },
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private fusePage(
    lanes: readonly CompleteLane[],
    limit: number,
  ): {
    items: SearchResponse['items'];
    found: number;
  } {
    interface Accumulator {
      candidate: SearchCandidate;
      score: number;
      matchedLanes: string[];
    }

    const byRef = new Map<string, Accumulator>();
    for (const lane of lanes) {
      lane.result.candidates.forEach((candidate, index) => {
        const contribution = 1 / (this.options.reciprocalRankConstant + index + 1);
        const existing = byRef.get(candidate.ref);
        if (existing) {
          existing.score += contribution;
          if (!existing.matchedLanes.includes(lane.coverage.laneId)) {
            existing.matchedLanes.push(lane.coverage.laneId);
          }
        } else {
          byRef.set(candidate.ref, {
            candidate,
            score: contribution,
            matchedLanes: [lane.coverage.laneId],
          });
        }
      });
    }

    const ranked = [...byRef.values()].sort(
      (left, right) =>
        right.score - left.score ||
        this.occurredAtMs(right.candidate) - this.occurredAtMs(left.candidate) ||
        left.candidate.ref.localeCompare(right.candidate.ref),
    );
    const maximumScore = ranked[0]?.score ?? 1;
    const page = ranked.slice(0, limit);
    const items = page.map((entry, index) => ({
      ...entry.candidate,
      ranking: {
        rank: index + 1,
        score: entry.score / maximumScore,
        matchedLanes: entry.matchedLanes.sort(),
      },
    }));
    return {
      items,
      found: ranked.length,
    };
  }

  private occurredAtMs(candidate: SearchCandidate): number {
    return candidate.occurredAt ? Date.parse(candidate.occurredAt) : Number.NEGATIVE_INFINITY;
  }

  private elapsedSince(startedAt: number): number {
    return Math.max(0, Math.round(this.clock.nowMs() - startedAt));
  }

  private async withDeadline<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    deadlineMs: number,
  ): Promise<T> {
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new LaneTimeoutError());
      }, deadlineMs);
    });
    try {
      return await Promise.race([operation(controller.signal), timeout]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }
}

class LaneTimeoutError extends Error {}
