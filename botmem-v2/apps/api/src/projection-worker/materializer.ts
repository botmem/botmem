import { createHash } from 'node:crypto';
import type { QueryEmbeddingPort } from '../search/postgres-ports.js';
import { HostedSearchFailure } from '../search/errors.js';
import {
  transformHostedProjection,
  HostedProjectionTransformError,
} from '../search/hosted-projection-transformer.js';
import type { PostgresHostedProjectionStore } from '../search/postgres-hosted-projection.js';
import { OpenAiEmbeddingError } from '../search/openai-embedding.js';
import type {
  HostedProjectionInputPort,
  ProjectionWorkerClockPort,
  ProjectionWorkerReasonCode,
  SearchReadinessProbePort,
} from './ports.js';
import { ProjectionInputUnavailableError } from './postgres-input.js';
import { SearchReadinessProbeError } from './postgres-readiness-probe.js';

export interface MaterializeProjectionCommand {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly revisionId: string;
  readonly workerId: string;
  readonly leaseExpiresAt: string;
  readonly signal: AbortSignal;
}

export interface MaterializeProjectionResult {
  readonly projection: 'applied' | 'already_applied';
  readonly readiness: 'ready' | 'deferred';
}

/** Application service joining tenant input, transform, embedding, projection and probe. */
export class HostedProjectionMaterializer {
  constructor(
    private readonly input: HostedProjectionInputPort,
    private readonly embeddings: QueryEmbeddingPort,
    private readonly store: Pick<PostgresHostedProjectionStore, 'project' | 'markSearchProbeReady'>,
    private readonly readiness: SearchReadinessProbePort,
    private readonly clock: ProjectionWorkerClockPort = { nowMs: () => Date.now() },
  ) {}

  async project(command: MaterializeProjectionCommand): Promise<MaterializeProjectionResult> {
    throwIfAborted(command.signal);
    const source = await this.input.load(command);
    throwIfAborted(command.signal);
    const material = transformHostedProjection(source);
    const embedding =
      material.embeddingInput === null
        ? null
        : await this.embeddings.embed(material.embeddingInput, command.signal);
    throwIfAborted(command.signal);

    const outputHash = projectionOutputHash({
      candidate: material.candidate,
      embeddingProfileId: embedding?.profileId ?? null,
      embeddingModelRevision: embedding?.modelRevision ?? null,
    });
    const projectedAt = new Date(this.clock.nowMs()).toISOString();
    const projection = await this.store.project({
      workspaceId: command.workspaceId,
      accountId: command.accountId,
      revisionId: command.revisionId,
      workerId: command.workerId,
      leaseExpiresAt: command.leaseExpiresAt,
      projectedAt,
      outputHash,
      candidate: material.candidate,
      embedding,
      signal: command.signal,
    });

    const readiness = await this.readiness.probe({
      workspaceId: command.workspaceId,
      accountId: command.accountId,
      signal: command.signal,
    });
    if (readiness === 'ready') {
      try {
        await this.store.markSearchProbeReady({
          workspaceId: command.workspaceId,
          accountId: command.accountId,
          probedAt: new Date(this.clock.nowMs()).toISOString(),
          signal: command.signal,
        });
      } catch (error) {
        // A new ingest head can race the probe. The durable projection is still
        // complete, while health remains correctly unsearchable until repair.
        if (error instanceof HostedSearchFailure && error.code === 'search_probe_rejected') {
          return Object.freeze({ projection, readiness: 'deferred' });
        }
        throw error;
      }
    }
    return Object.freeze({ projection, readiness });
  }
}

export function projectionOutputHash(input: {
  readonly candidate: unknown;
  readonly embeddingProfileId: string | null;
  readonly embeddingModelRevision: string | null;
}): string {
  return createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex');
}

export function projectionFailureReason(error: unknown): ProjectionWorkerReasonCode {
  if (isAbortError(error)) return 'task_cancelled';
  if (error instanceof ProjectionInputUnavailableError) return 'projection_input_unavailable';
  if (error instanceof HostedProjectionTransformError) return 'projection_transform_rejected';
  if (error instanceof OpenAiEmbeddingError) return 'embedding_failed';
  if (error instanceof SearchReadinessProbeError) return 'search_probe_failed';
  if (error instanceof HostedSearchFailure && error.code === 'projection_lease_conflict') {
    return 'projection_lease_conflict';
  }
  return 'projection_failed';
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('projection task cancelled');
  error.name = 'AbortError';
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
