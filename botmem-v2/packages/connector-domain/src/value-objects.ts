import { InvalidDomainValueError } from './errors.js';

declare const brand: unique symbol;
type Branded<T, Name extends string> = T & { readonly [brand]: Name };

export type TenantId = Branded<string, 'TenantId'>;
export type ConnectorAccountId = Branded<string, 'ConnectorAccountId'>;
export type SyncId = Branded<string, 'SyncId'>;
export type IngestRevisionId = Branded<string, 'IngestRevisionId'>;
export type OutboxMessageId = Branded<string, 'OutboxMessageId'>;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseUuid<Name extends string>(value: string, label: Name): Branded<string, Name> {
  if (!UUID_PATTERN.test(value)) {
    throw new InvalidDomainValueError(`${label} must be a UUID`);
  }
  return value as Branded<string, Name>;
}

export function tenantId(value: string): TenantId {
  return parseUuid(value, 'TenantId');
}

export function connectorAccountId(value: string): ConnectorAccountId {
  return parseUuid(value, 'ConnectorAccountId');
}

export function syncId(value: string): SyncId {
  return parseUuid(value, 'SyncId');
}

export function ingestRevisionId(value: string): IngestRevisionId {
  return parseUuid(value, 'IngestRevisionId');
}

export function outboxMessageId(value: string): OutboxMessageId {
  return parseUuid(value, 'OutboxMessageId');
}

export function nonEmpty(value: string, label: string, maximumLength: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new InvalidDomainValueError(`${label} must contain 1-${maximumLength} characters`);
  }
  return normalized;
}

export function isoTimestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new InvalidDomainValueError(`${label} must be an ISO-8601 timestamp`);
  }
  return value;
}

export function sha256(value: string, label = 'contentHash'): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new InvalidDomainValueError(`${label} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

export function cloneJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneJson(item)));
  }
  return Object.freeze(
    Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)])),
  );
}
