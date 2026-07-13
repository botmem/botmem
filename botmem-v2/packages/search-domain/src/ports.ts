import type {
  Connector,
  SearchCandidate as ContractSearchCandidate,
  SearchRequest,
} from '@botmem-v2/contracts';

export type SearchCandidate = ContractSearchCandidate;

export interface RankedLaneResult {
  readonly candidates: readonly SearchCandidate[];
  /** The lane returned useful results but one ranking capability was unavailable. */
  readonly degradation?: {
    readonly reasonCode: string;
    readonly retryable: boolean;
  };
}

export interface SearchLaneContext {
  readonly queryId: string;
  readonly signal: AbortSignal;
}

export interface HostedSearchPort {
  search(
    workspaceId: string,
    request: SearchRequest,
    context: SearchLaneContext,
  ): Promise<RankedLaneResult>;
}

export type DeviceAvailability =
  | 'ready'
  | 'offline'
  | 'permission_required'
  | 'indexing'
  | 'failed';

export interface DeviceConnectorTarget {
  readonly connector: Extract<Connector, 'imessage' | 'whatsapp'>;
  readonly availability: DeviceAvailability;
  readonly searchable: boolean;
  readonly reasonCode?: string;
}

export interface DeviceTarget {
  readonly deviceId: string;
  readonly availability: DeviceAvailability;
  readonly connectors: readonly Extract<Connector, 'imessage' | 'whatsapp'>[];
  readonly sources: readonly DeviceConnectorTarget[];
  readonly reasonCode?: string;
}

export interface DeviceDirectoryPort {
  listSearchTargets(workspaceId: string, signal: AbortSignal): Promise<readonly DeviceTarget[]>;
}

export interface DeviceSearchPort {
  search(
    workspaceId: string,
    device: DeviceTarget,
    request: SearchRequest,
    context: SearchLaneContext,
  ): Promise<RankedLaneResult>;
}

export interface ClockPort {
  nowMs(): number;
}

export interface QueryIdPort {
  next(): string;
}
