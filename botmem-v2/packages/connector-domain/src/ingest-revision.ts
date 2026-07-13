import { IdempotencyConflictError, InvalidDomainValueError } from './errors.js';
import {
  cloneJson,
  isoTimestamp,
  nonEmpty,
  sha256,
  type IngestRevisionId,
  type JsonValue,
  type OutboxMessageId,
} from './value-objects.js';

export type HostedMemoryKind = 'email' | 'location';

export interface ProviderEventRevisionInput {
  readonly sourceEventId: string;
  readonly sourceRevision: string;
  readonly kind: HostedMemoryKind;
  readonly occurredAt: string | null;
  readonly contentHash: string;
  readonly payload: JsonValue;
  readonly tombstone?: boolean;
}

export interface PlannedIngestRevision {
  readonly id: IngestRevisionId;
  readonly outboxId: OutboxMessageId;
  readonly sourceEventId: string;
  readonly sourceRevision: string;
  readonly kind: HostedMemoryKind;
  readonly occurredAt: string | null;
  readonly observedAt: string;
  readonly contentHash: string;
  readonly payload: JsonValue;
  readonly tombstone: boolean;
}

export interface RevisionIdentity {
  readonly sourceEventId: string;
  readonly sourceRevision: string;
}

export function revisionIdentityKey(revision: RevisionIdentity): string {
  return `${revision.sourceEventId.length}:${revision.sourceEventId}${revision.sourceRevision}`;
}

export function planIngestRevisions(
  inputs: readonly ProviderEventRevisionInput[],
  observedAt: string,
  nextRevisionId: () => IngestRevisionId,
  nextOutboxId: () => OutboxMessageId,
): readonly PlannedIngestRevision[] {
  isoTimestamp(observedAt, 'observedAt');

  const planned = new Map<string, PlannedIngestRevision>();
  for (const input of inputs) {
    const sourceEventId = nonEmpty(input.sourceEventId, 'sourceEventId', 2048);
    const sourceRevision = nonEmpty(input.sourceRevision, 'sourceRevision', 512);
    const occurredAt =
      input.occurredAt === null ? null : isoTimestamp(input.occurredAt, 'occurredAt');
    const contentHash = sha256(input.contentHash);
    if (
      input.tombstone === true &&
      (input.payload === null ||
        typeof input.payload !== 'object' ||
        Array.isArray(input.payload) ||
        Object.keys(input.payload).length > 16)
    ) {
      throw new InvalidDomainValueError('tombstone payload must be a metadata object');
    }

    const candidate: PlannedIngestRevision = Object.freeze({
      id: nextRevisionId(),
      outboxId: nextOutboxId(),
      sourceEventId,
      sourceRevision,
      kind: input.kind,
      occurredAt,
      observedAt,
      contentHash,
      payload: cloneJson(input.payload),
      tombstone: input.tombstone ?? false,
    });
    const key = revisionIdentityKey(candidate);
    const existing = planned.get(key);
    if (existing) {
      if (existing.contentHash !== candidate.contentHash) {
        throw new IdempotencyConflictError();
      }
      continue;
    }
    planned.set(key, candidate);
  }
  return Object.freeze([...planned.values()]);
}
