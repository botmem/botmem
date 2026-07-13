import { describe, expect, it, vi } from 'vitest';
import type { OutboxDispatcherPort, ProjectionWorkerTelemetryPort } from './ports.js';
import { OutboxSettlementConflictError } from './postgres-dispatcher.js';
import { ProjectionOutboxWorker } from './worker.js';

const message = {
  messageId: '10000000-0000-4000-8000-000000000001',
  workspaceId: '20000000-0000-4000-8000-000000000002',
  accountId: '30000000-0000-4000-8000-000000000003',
  revisionId: '40000000-0000-4000-8000-000000000004',
  attempt: 1,
  leaseExpiresAt: '2026-07-13T10:01:00.000Z',
};

describe('ProjectionOutboxWorker', () => {
  it('claims, materializes and owner-fenced publishes a bounded batch', async () => {
    const dispatcher = fakeDispatcher([message]);
    const project = vi.fn().mockResolvedValue({ projection: 'applied', readiness: 'ready' });
    const telemetry = fakeTelemetry();
    const worker = createWorker(dispatcher, project, telemetry);

    await expect(worker.runOnce()).resolves.toBe(1);

    expect(dispatcher.claim).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 2, leaseMs: 60_000 }),
    );
    expect(project).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: message.workspaceId,
        revisionId: message.revisionId,
        leaseExpiresAt: message.leaseExpiresAt,
      }),
    );
    expect(dispatcher.complete).toHaveBeenCalledOnce();
    expect(dispatcher.fail).not.toHaveBeenCalled();
    expect(telemetry.metric).toHaveBeenCalledWith({ name: 'outbox_published', value: 1 });
  });

  it('retries with a future deadline and dead-letters at the attempt ceiling', async () => {
    const now = Date.parse('2026-07-13T10:00:00.000Z');
    const dispatcher = fakeDispatcher([{ ...message, attempt: 2 }]);
    const worker = createWorker(
      dispatcher,
      vi.fn().mockRejectedValue(new Error('secret provider response')),
      fakeTelemetry(),
      { nowMs: () => now },
    );
    await worker.runOnce();
    expect(dispatcher.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        dead: false,
        nextAttemptAt: expect.any(String),
      }),
    );
    expect(Date.parse(dispatcher.fail.mock.calls[0]?.[0].nextAttemptAt)).toBeGreaterThan(now);

    const finalDispatcher = fakeDispatcher([{ ...message, attempt: 3 }]);
    const finalWorker = createWorker(
      finalDispatcher,
      vi.fn().mockRejectedValue(new Error('still secret')),
      fakeTelemetry(),
      { nowMs: () => now },
    );
    await finalWorker.runOnce();
    expect(finalDispatcher.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        dead: true,
        nextAttemptAt: '2026-07-13T10:00:00.000Z',
      }),
    );
  });

  it('leaves a committed projection leased when publish settlement loses ownership', async () => {
    const dispatcher = fakeDispatcher([message]);
    dispatcher.complete.mockRejectedValue(new OutboxSettlementConflictError());
    const telemetry = fakeTelemetry();
    const worker = createWorker(
      dispatcher,
      vi.fn().mockResolvedValue({ projection: 'applied', readiness: 'ready' }),
      telemetry,
    );

    await worker.runOnce();

    expect(dispatcher.fail).not.toHaveBeenCalled();
    expect(telemetry.event).toHaveBeenCalledWith({
      level: 'warn',
      code: 'projection_settlement_conflict',
    });
  });

  it('never exceeds configured projection concurrency', async () => {
    const messages = Array.from({ length: 4 }, (_, index) => ({
      ...message,
      messageId: `10000000-0000-4000-8000-00000000000${index + 1}`,
      revisionId: `40000000-0000-4000-8000-00000000000${index + 1}`,
    }));
    const dispatcher = fakeDispatcher(messages);
    let active = 0;
    let maximum = 0;
    const project = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { projection: 'applied' as const, readiness: 'ready' as const };
    });
    const worker = createWorker(dispatcher, project, fakeTelemetry(), undefined, 4);

    await worker.runOnce();

    expect(maximum).toBe(4);
    expect(dispatcher.claim).toHaveBeenCalledWith(expect.objectContaining({ limit: 4 }));
  });

  it('repairs tenant projection debt without outbox content access', async () => {
    const dispatcher = fakeDispatcher([]);
    dispatcher.listRepairWorkspaces
      .mockResolvedValueOnce([message.workspaceId])
      .mockResolvedValueOnce([]);
    const project = vi.fn().mockResolvedValue({ projection: 'applied', readiness: 'ready' });
    const telemetry = fakeTelemetry();
    const repairStore = {
      listRepairable: vi
        .fn()
        .mockResolvedValue([{ accountId: message.accountId, revisionId: message.revisionId }]),
    };
    const worker = new ProjectionOutboxWorker(
      dispatcher,
      { project },
      repairStore,
      telemetry,
      options(),
      { nowMs: () => Date.parse('2026-07-13T10:00:00.000Z') },
    );

    await expect(worker.runRepairOnce()).resolves.toBe(1);
    expect(project).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: message.workspaceId,
        accountId: message.accountId,
        revisionId: message.revisionId,
        workerId: 'projection-1:repair',
      }),
    );
    expect(telemetry.metric).toHaveBeenCalledWith({ name: 'projection_repaired', value: 1 });
  });
});

function createWorker(
  dispatcher: ReturnType<typeof fakeDispatcher>,
  project: ReturnType<typeof vi.fn>,
  telemetry: ReturnType<typeof fakeTelemetry>,
  clock = { nowMs: () => Date.parse('2026-07-13T10:00:00.000Z') },
  concurrency = 2,
) {
  return new ProjectionOutboxWorker(
    dispatcher,
    { project },
    { listRepairable: vi.fn().mockResolvedValue([]) },
    telemetry,
    { ...options(), concurrency, batchSize: 16 },
    clock,
  );
}

function options() {
  return {
    workerId: 'projection-1',
    batchSize: 2,
    concurrency: 2,
    leaseMs: 60_000,
    taskTimeoutMs: 45_000,
    maxAttempts: 3,
    backoffBaseMs: 1_000,
    backoffMaxMs: 60_000,
  };
}

function fakeDispatcher(messages: readonly (typeof message)[]) {
  return {
    claim: vi.fn().mockResolvedValue(messages),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    listRepairWorkspaces: vi.fn().mockResolvedValue([]),
  } satisfies OutboxDispatcherPort as OutboxDispatcherPort & {
    claim: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
    fail: ReturnType<typeof vi.fn>;
    listRepairWorkspaces: ReturnType<typeof vi.fn>;
  };
}

function fakeTelemetry() {
  return {
    event: vi.fn(),
    metric: vi.fn(),
  } satisfies ProjectionWorkerTelemetryPort;
}
