import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryController } from '../memory.controller';

function createDbMock() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return {
    execute: vi.fn(),
    update,
    set,
    where,
  };
}

function createController() {
  const db = createDbMock();
  const memoryService = {
    needsRecoveryKey: vi.fn().mockResolvedValue(false),
  };
  const memoryQueue = {
    getJob: vi.fn().mockResolvedValue(null),
    add: vi.fn().mockResolvedValue(undefined),
  };
  const controller = new MemoryController(
    memoryService as never,
    { db } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    memoryQueue as never,
    {} as never,
  );
  return { controller, db, memoryService, memoryQueue };
}

describe('MemoryController raw event retry debt', () => {
  const user = { id: 'user-1' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates date ranges before enqueueing retry work', async () => {
    const { controller, db, memoryQueue } = createController();

    await expect(
      controller.retryRawEventDebt(user, {
        from: '2026-05-02T00:00:00Z',
        to: '2026-05-01T00:00:00Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(db.execute).not.toHaveBeenCalled();
    expect(memoryQueue.add).not.toHaveBeenCalled();
  });

  it('skips raw events that already have an active deterministic retry job', async () => {
    const { controller, db, memoryQueue } = createController();
    db.execute.mockResolvedValueOnce({
      rows: [{ rawEventId: 'raw-1', processingState: 'failed' }],
    });
    memoryQueue.getJob.mockResolvedValueOnce({
      getState: vi.fn().mockResolvedValue('active'),
    });

    await expect(controller.retryRawEventDebt(user, { limit: 1 })).resolves.toEqual({
      enqueued: 0,
      skippedExistingJob: 1,
      errors: 0,
      total: 1,
    });

    expect(db.update).not.toHaveBeenCalled();
    expect(memoryQueue.add).not.toHaveBeenCalled();
  });

  it('resets selected raw events to pending and enqueue retries with stable job ids', async () => {
    const { controller, db, memoryQueue } = createController();
    db.execute.mockResolvedValueOnce({
      rows: [{ rawEventId: 'raw-1', processingState: 'failed' }],
    });

    await expect(
      controller.retryRawEventDebt(user, {
        connectorType: 'gmail',
        sourceType: 'email',
        from: '2026-05-01T00:00:00Z',
        to: '2026-05-02T00:00:00Z',
        states: ['failed'],
        limit: 1,
      }),
    ).resolves.toEqual({
      enqueued: 1,
      skippedExistingJob: 0,
      errors: 0,
      total: 1,
    });

    expect(db.set).toHaveBeenCalledWith({ processingState: 'pending' });
    expect(memoryQueue.add).toHaveBeenCalledWith(
      'process',
      { rawEventId: 'raw-1' },
      expect.objectContaining({
        attempts: 5,
        jobId: 'raw-event-retry-raw-1',
      }),
    );
  });

  it('does not enqueue when the user needs a recovery key', async () => {
    const { controller, db, memoryService, memoryQueue } = createController();
    memoryService.needsRecoveryKey.mockResolvedValueOnce(true);

    await expect(controller.retryRawEventDebt(user, { limit: 1 })).resolves.toMatchObject({
      enqueued: 0,
      needsRecoveryKey: true,
    });

    expect(db.execute).not.toHaveBeenCalled();
    expect(memoryQueue.add).not.toHaveBeenCalled();
  });
});
