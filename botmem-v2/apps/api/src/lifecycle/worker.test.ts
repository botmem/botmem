import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { HostedExportRecord, LifecycleJobClaim } from './domain.js';
import type {
  LifecycleArtifactStorePort,
  LifecycleArtifactWriterPort,
  LifecycleWorkerRepositoryPort,
} from './ports.js';
import { exportRecordLines, WorkspaceLifecycleWorker } from './worker.js';

const DELETION: LifecycleJobClaim = {
  jobId: 'd1000000-0000-4000-8000-000000000001',
  tenantId: 'd1000000-0000-4000-8000-000000000002',
  workspaceId: 'd1000000-0000-4000-8000-000000000002',
  requestedByUserId: 'd1000000-0000-4000-8000-000000000003',
  kind: 'deletion',
  attempts: 1,
  leaseToken: 'd1000000-0000-4000-8000-000000000004',
};

const EXPORT: LifecycleJobClaim = { ...DELETION, kind: 'export' };

describe('WorkspaceLifecycleWorker billing boundary', () => {
  it('defersWithoutPurgingWhenRemoteBillingIsUnsettled', async () => {
    const repository = new LifecycleRepository('pending');
    const artifacts = new LifecycleArtifacts();

    await expect(build(repository, artifacts).runOnce()).resolves.toBe(true);

    expect(repository.deferred).toEqual({
      jobId: DELETION.jobId,
      workerId: 'lifecycle.test',
      leaseToken: DELETION.leaseToken,
      now: '2026-07-13T10:00:00.000Z',
      retryAt: '2026-07-13T10:00:30.000Z',
      reason: 'BILLING_CANCELLATION_PENDING',
    });
    expect(repository.listedArtifacts).toBe(false);
    expect(repository.completedDeletion).toBe(false);
    expect(artifacts.deletedWorkspace).toBe(false);
  });

  it('deletesHostedStateAfterBillingSettlementWithoutWaitingForOfflineDevices', async () => {
    const repository = new LifecycleRepository('confirmed', 1);
    const artifacts = new LifecycleArtifacts();

    await expect(build(repository, artifacts).runOnce()).resolves.toBe(true);

    expect(repository.deferred).toBeUndefined();
    expect(repository.completedDeletion).toBe(true);
    expect(artifacts.deletedWorkspace).toBe(true);
  });

  it('never calls destructive storage after the exact claim loses authorization', async () => {
    const repository = new LifecycleRepository('confirmed', 0, false);
    const artifacts = new LifecycleArtifacts();

    await expect(build(repository, artifacts).runOnce()).resolves.toBe(true);

    expect(repository.completedDeletion).toBe(false);
    expect(artifacts.deletedWorkspace).toBe(false);
  });
});

describe('workspace export record encoding', () => {
  const item: HostedExportRecord = {
    accountId: 'd1000000-0000-4000-8000-000000000010',
    sourceEventId: 'message-large',
    connector: 'gmail',
    sourceRevision: 'history:42',
    kind: 'email',
    occurredAt: '2026-07-13T09:00:00.000Z',
    observedAt: '2026-07-13T10:00:00.000Z',
    payload: { body: 'قرار launch 🚀 '.repeat(200) },
    tombstone: false,
  };

  it('chunksAndReassemblesAnOversizedRecordWithoutDataLoss', () => {
    const lines = exportRecordLines(item, 320);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => Buffer.byteLength(line, 'utf8') <= 320)).toBe(true);
    const chunks = lines.map(
      (line) =>
        JSON.parse(line) as {
          type: string;
          recordSha256: string;
          chunkIndex: number;
          chunkCount: number;
          data: string;
        },
    );
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(
      Array.from({ length: chunks.length }, (_unused, index) => index),
    );
    expect(chunks.every((chunk) => chunk.type === 'hosted_event_chunk')).toBe(true);
    expect(chunks.every((chunk) => chunk.chunkCount === chunks.length)).toBe(true);

    const recovered = Buffer.from(
      chunks.map((chunk) => chunk.data).join(''),
      'base64url',
    );
    expect(createHash('sha256').update(recovered).digest('hex')).toBe(
      chunks[0]?.recordSha256,
    );
    expect(JSON.parse(recovered.toString('utf8').trim())).toMatchObject({
      type: 'hosted_event',
      sourceEventId: item.sourceEventId,
      payload: item.payload,
    });
  });

  it('keepsABoundedRecordAsOneNormalHostedEventLine', () => {
    const lines = exportRecordLines({ ...item, payload: { body: 'small' } }, 2_048);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: 'hosted_event',
      sourceEventId: item.sourceEventId,
      payload: { body: 'small' },
    });
  });
});

describe('workspace export crash recovery', () => {
  it('adoptsAnAuthenticatedCommittedArtifactWithoutCreatingAnotherReservation', async () => {
    const artifactKey = `${EXPORT.workspaceId}/${EXPORT.jobId}.bme`;
    const repository = new LifecycleRepository('not_required', 0, true, EXPORT);
    const artifacts = new LifecycleArtifacts(artifactKey);

    await expect(build(repository, artifacts).runOnce()).resolves.toBe(true);

    expect(artifacts.createCalled).toBe(false);
    expect(repository.completedExport?.artifactKey).toBe(artifactKey);
  });
});

class LifecycleRepository implements LifecycleWorkerRepositoryPort {
  private claimValue: LifecycleJobClaim | null;
  deferred?: Parameters<LifecycleWorkerRepositoryPort['deferDeletion']>[0];
  listedArtifacts = false;
  completedDeletion = false;
  completedExport?: Parameters<LifecycleWorkerRepositoryPort['completeExport']>[0];

  constructor(
    private readonly billingState: 'not_required' | 'pending' | 'processing' | 'confirmed' | 'dead',
    private readonly pendingNotices = 0,
    private readonly destructionAuthorized = true,
    claimValue: LifecycleJobClaim = DELETION,
  ) {
    this.claimValue = claimValue;
  }

  async claim() {
    const value = this.claimValue;
    this.claimValue = null;
    return value;
  }
  async renewLease() {
    return true;
  }
  async readExportPage() {
    return { items: [], nextCursor: null };
  }
  async deletionBlockers() {
    return { pendingNotices: this.pendingNotices, billingState: this.billingState };
  }
  async deferDeletion(input: Parameters<LifecycleWorkerRepositoryPort['deferDeletion']>[0]) {
    this.deferred = input;
    return true;
  }
  async listDeletionArtifacts() {
    this.listedArtifacts = true;
    return [];
  }
  async completeExport(input: Parameters<LifecycleWorkerRepositoryPort['completeExport']>[0]) {
    this.completedExport = input;
    return true;
  }
  async completeDeletion() {
    this.completedDeletion = true;
    return true;
  }
  async authorizeWorkspaceDestruction() {
    return this.destructionAuthorized;
  }
  async fail() {
    return null;
  }
  async heartbeat() {}
  async listExpiredArtifacts() {
    return [];
  }
  async completeArtifactPurge() {
    return true;
  }
  async purgeExpiredBillingAudits() {
    return 0;
  }
  async repair() {
    return false;
  }
}

class LifecycleArtifacts implements LifecycleArtifactStorePort {
  deletedWorkspace = false;
  createCalled = false;
  constructor(private readonly recoveredKey: string | null = null) {}
  async recover() {
    return this.recoveredKey;
  }
  async open() {
    return Readable.from([]);
  }
  async create(): Promise<LifecycleArtifactWriterPort> {
    this.createCalled = true;
    throw new Error('not used');
  }
  async delete() {}
  async deleteWorkspace() {
    this.deletedWorkspace = true;
  }
  async ready() {
    return true;
  }
}

function build(repository: LifecycleWorkerRepositoryPort, artifacts: LifecycleArtifactStorePort) {
  return new WorkspaceLifecycleWorker(
    repository,
    artifacts,
    { nowMs: () => Date.parse('2026-07-13T10:00:00.000Z') },
    { event: () => undefined },
    { workerId: 'lifecycle.test' },
  );
}
