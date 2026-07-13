import { describe, expect, it } from 'vitest';
import {
  IdempotencyConflictError,
  ProjectionLeaseConflictError,
  ProjectionState,
  ingestRevisionId,
} from './index.js';

const REVISION_ID = ingestRevisionId('40000000-0000-4000-8000-000000000001');

describe('ProjectionState', () => {
  it('markApplied_whenDeliveryRepeats_isIdempotentForTheSameOutput', () => {
    const processing = ProjectionState.pending('search-v1', REVISION_ID).claim(
      'worker-1',
      '2026-07-13T10:00:00.000Z',
      '2026-07-13T10:05:00.000Z',
    );
    const applied = processing.markApplied('worker-1', 'a'.repeat(64), '2026-07-13T10:01:00.000Z');

    expect(applied.markApplied('worker-1', 'a'.repeat(64), '2026-07-13T10:02:00.000Z')).toBe(
      applied,
    );
    expect(() =>
      applied.markApplied('worker-1', 'b'.repeat(64), '2026-07-13T10:02:00.000Z'),
    ).toThrow(IdempotencyConflictError);
  });

  it('claim_whenAnotherWorkerHasLiveLease_rejectsUntilLeaseExpires', () => {
    const processing = ProjectionState.pending('search-v1', REVISION_ID).claim(
      'worker-1',
      '2026-07-13T10:00:00.000Z',
      '2026-07-13T10:05:00.000Z',
    );

    expect(() =>
      processing.claim('worker-2', '2026-07-13T10:01:00.000Z', '2026-07-13T10:06:00.000Z'),
    ).toThrow(ProjectionLeaseConflictError);
    const reclaimed = processing.claim(
      'worker-2',
      '2026-07-13T10:05:01.000Z',
      '2026-07-13T10:10:00.000Z',
    );
    expect(reclaimed.snapshot()).toMatchObject({
      status: 'processing',
      attempts: 2,
      lease: { workerId: 'worker-2' },
    });
  });
});
