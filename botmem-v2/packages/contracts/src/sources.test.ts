import { describe, expect, it } from 'vitest';
import { SourceStatusSchema } from './sources.js';

describe('SourceStatus contract', () => {
  it('SourceStatusSchema_whenReadyWithoutCheckpoint_rejectsFalseReadiness', () => {
    expect(() =>
      SourceStatusSchema.parse({
        connector: 'imessage',
        readiness: 'ready',
        detail: 'ready',
        searchable: true,
      }),
    ).toThrow(/completed checkpoint/);
  });

  it('SourceStatusSchema_whenReadyAfterCheckpointAndProbe_acceptsStatus', () => {
    const status = {
      connector: 'imessage',
      readiness: 'ready',
      detail: 'ready',
      searchable: true,
      indexedCount: 42,
      checkpointAt: '2026-07-13T12:00:00.000Z',
      lastProbeAt: '2026-07-13T12:00:01.000Z',
    } as const;

    expect(SourceStatusSchema.parse(status)).toEqual(status);
  });

  it('SourceStatusSchema_whenReadyButPermissionIsRequired_rejectsContradiction', () => {
    expect(() =>
      SourceStatusSchema.parse({
        connector: 'imessage',
        readiness: 'ready',
        detail: 'permission_required',
        searchable: true,
        checkpointAt: '2026-07-13T12:00:00.000Z',
        lastProbeAt: '2026-07-13T12:00:01.000Z',
      }),
    ).toThrow(/ready detail/);
  });
});
