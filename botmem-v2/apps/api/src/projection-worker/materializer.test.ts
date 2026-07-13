import { describe, expect, it, vi } from 'vitest';
import type { QueryEmbeddingPort } from '../search/postgres-ports.js';
import { HostedSearchFailure } from '../search/errors.js';
import type { PostgresHostedProjectionStore } from '../search/postgres-hosted-projection.js';
import { HostedProjectionMaterializer, projectionOutputHash } from './materializer.js';
import type { HostedProjectionInputPort, SearchReadinessProbePort } from './ports.js';

const signal = new AbortController().signal;
const ids = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  accountId: '20000000-0000-4000-8000-000000000002',
  revisionId: '30000000-0000-4000-8000-000000000003',
};

describe('HostedProjectionMaterializer', () => {
  it('embeds, projects with a stable model-bound hash, and marks a real probe ready', async () => {
    const project = vi.fn().mockResolvedValue('applied');
    const markSearchProbeReady = vi.fn().mockResolvedValue(undefined);
    const embed = vi.fn().mockResolvedValue(embedding('provider-revision-1'));
    const materializer = createMaterializer({
      input: emailInput(),
      embed,
      project,
      markSearchProbeReady,
      readiness: 'ready',
    });

    const result = await materializer.project(command());

    expect(result).toEqual({ projection: 'applied', readiness: 'ready' });
    expect(embed).toHaveBeenCalledWith('Subject\nmessage body', signal);
    expect(project).toHaveBeenCalledOnce();
    expect(project.mock.calls[0]?.[0].outputHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(markSearchProbeReady).toHaveBeenCalledOnce();
  });

  it('does not embed tombstones and tolerates readiness invalidation races', async () => {
    const project = vi.fn().mockResolvedValue('already_applied');
    const markSearchProbeReady = vi
      .fn()
      .mockRejectedValue(new HostedSearchFailure('search_probe_rejected'));
    const embed = vi.fn();
    const materializer = createMaterializer({
      input: { ...emailInput(), tombstone: true },
      embed,
      project,
      markSearchProbeReady,
      readiness: 'ready',
    });

    await expect(materializer.project(command())).resolves.toEqual({
      projection: 'already_applied',
      readiness: 'deferred',
    });
    expect(embed).not.toHaveBeenCalled();
    expect(project.mock.calls[0]?.[0]).toMatchObject({ candidate: null, embedding: null });
  });

  it('hashes canonical output and model revision, never embedding float values', () => {
    const first = projectionOutputHash({
      candidate: { z: 1, a: { second: true, first: 'x' } },
      embeddingProfileId: 'profile',
      embeddingModelRevision: 'revision-1',
    });
    const reordered = projectionOutputHash({
      candidate: { a: { first: 'x', second: true }, z: 1 },
      embeddingProfileId: 'profile',
      embeddingModelRevision: 'revision-1',
    });
    const changedModel = projectionOutputHash({
      candidate: { a: { first: 'x', second: true }, z: 1 },
      embeddingProfileId: 'profile',
      embeddingModelRevision: 'revision-2',
    });
    expect(first).toBe(reordered);
    expect(first).not.toBe(changedModel);
  });
});

function createMaterializer(input: {
  readonly input: ReturnType<typeof emailInput>;
  readonly embed: ReturnType<typeof vi.fn>;
  readonly project: ReturnType<typeof vi.fn>;
  readonly markSearchProbeReady: ReturnType<typeof vi.fn>;
  readonly readiness: 'ready' | 'deferred';
}): HostedProjectionMaterializer {
  const reader: HostedProjectionInputPort = { load: vi.fn().mockResolvedValue(input.input) };
  const embeddings: QueryEmbeddingPort = { embed: input.embed };
  const store = {
    project: input.project,
    markSearchProbeReady: input.markSearchProbeReady,
  } as unknown as Pick<PostgresHostedProjectionStore, 'project' | 'markSearchProbeReady'>;
  const readiness: SearchReadinessProbePort = {
    probe: vi.fn().mockResolvedValue(input.readiness),
  };
  return new HostedProjectionMaterializer(reader, embeddings, store, readiness, {
    nowMs: () => Date.parse('2026-07-13T10:00:00.000Z'),
  });
}

function emailInput() {
  return {
    ...ids,
    connector: 'gmail' as const,
    sourceEventId: 'message-1',
    sourceRevision: 'revision-1',
    kind: 'email' as const,
    occurredAt: '2026-07-13T09:00:00.000Z',
    tombstone: false,
    payload: {
      schema: 'gmail.message.v1',
      normalized: {
        sourceId: 'message-1',
        title: 'Subject',
        text: 'message body',
        participants: [],
        media: [],
      },
    },
  };
}

function embedding(modelRevision: string) {
  return {
    profileId: 'hosted-multilingual-v1' as const,
    modelRevision,
    values: Object.freeze(Array.from({ length: 768 }, (_, index) => index / 768)),
  };
}

function command() {
  return {
    ...ids,
    workerId: 'worker-1',
    leaseExpiresAt: '2026-07-13T10:01:00.000Z',
    signal,
  };
}
