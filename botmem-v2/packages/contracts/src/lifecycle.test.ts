import { describe, expect, it } from 'vitest';
import { LifecycleJobSchema, WorkspaceDeletionRequestSchema } from './lifecycle.js';

describe('workspace lifecycle contracts', () => {
  it('exposes state and local-delivery counts without internal artifact or lease data', () => {
    const job = LifecycleJobSchema.parse({
      version: 2,
      jobId: '10000000-0000-4000-8000-000000000001',
      kind: 'deletion',
      state: 'running',
      requestedAt: '2026-07-13T10:00:00.000Z',
      attempts: 1,
      availableUntil: null,
      completedAt: null,
      failureCode: null,
      localDelete: { delivered: 1, unreachable: 1, pending: 0 },
    });
    expect(job).not.toHaveProperty('artifactKey');
    expect(job).not.toHaveProperty('leaseOwner');
  });

  it('requires a versioned typed-confirmation request', () => {
    expect(() =>
      WorkspaceDeletionRequestSchema.parse({
        version: 2,
        confirmation: 'DELETE 10000000-0000-4000-8000-000000000001',
      }),
    ).not.toThrow();
  });
});
