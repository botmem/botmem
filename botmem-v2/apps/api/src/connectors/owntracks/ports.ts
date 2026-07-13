import type { ConnectorAccountId, JsonValue, TenantId } from '@botmem-v2/connector-domain';

export interface OwnTracksBasicCredentials {
  readonly username: string;
  readonly password: string;
}

/** Credentials are always retrieved by opaque vault reference, never from connector config. */
export interface OwnTracksCredentialVaultPort {
  read(
    owner: { readonly tenantId: TenantId; readonly accountId: ConnectorAccountId },
    credentialRef: string,
  ): Promise<OwnTracksBasicCredentials>;
  revoke(
    owner: { readonly tenantId: TenantId; readonly accountId: ConnectorAccountId },
    credentialRef: string,
  ): Promise<void>;
}

export interface OwnTracksClockPort {
  now(): string;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export interface OwnTracksHashPort {
  sha256Hex(value: string): Promise<string>;
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface OwnTracksDnsPort {
  resolveAll(hostname: string, signal?: AbortSignal): Promise<readonly ResolvedAddress[]>;
}

export interface PinnedHttpsRequest {
  readonly url: URL;
  readonly address: ResolvedAddress;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly signal?: AbortSignal;
}

export interface PinnedHttpsResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

/**
 * The transport must connect to address exactly. It must use url.hostname only
 * for TLS SNI/certificate verification and the Host header; no second DNS lookup
 * is permitted after the endpoint policy has approved the address set.
 */
export interface PinnedHttpsTransportPort {
  get(request: PinnedHttpsRequest): Promise<PinnedHttpsResponse>;
}

export interface OwnTracksEndpointConfiguration {
  readonly endpoint: string;
  readonly allowedPorts?: readonly number[];
}

export interface ValidatedOwnTracksEndpoint {
  readonly endpoint: string;
  readonly allowedPorts: readonly number[];
}

export interface OwnTracksLocationPage {
  readonly points: readonly JsonValue[];
}

export interface OwnTracksLocationApiPort {
  listLocations(
    endpoint: ValidatedOwnTracksEndpoint,
    credentials: OwnTracksBasicCredentials,
    range: { readonly fromEpochSeconds: number; readonly toEpochSeconds: number },
    signal?: AbortSignal,
  ): Promise<OwnTracksLocationPage>;
}
