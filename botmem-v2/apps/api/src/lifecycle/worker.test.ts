import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { LifecycleJobClaim } from './domain.js';
import type {
  LifecycleArtifactStorePort,
  LifecycleArtifactWriterPort,
  LifecycleWorkerRepositoryPort,
} from './ports.js';
import { WorkspaceLifecycleWorker } from './worker.js';

const DELETION: LifecycleJobClaim = {
  jobId: 'd1000000-0000-4000-8000-000000000001',
  tenantId: 'd1000000-0000-4000-8000-000000000002',
  workspaceId: 'd1000000-0000-4000-8000-000000000002',
  requestedByUserId: 'd1000000-0000-4000-8000-000000000003',
  kind: 'deletion',
  attempts: 1,
  leaseToken: 'd1000000-0000-4000-8000-000000000004',
};

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

class LifecycleRepository implements LifecycleWorkerRepositoryPort {
  private claimValue: LifecycleJobClaim | null = DELETION;
  deferred?: Parameters<LifecycleWorkerRepositoryPort['deferDeletion']>[0];
  listedArtifacts = false;
  completedDeletion = false;

  constructor(
    private readonly billingState: 'not_required' | 'pending' | 'processing' | 'confirmed' | 'dead',
    private readonly pendingNotices = 0,
    private readonly destructionAuthorized = true,
  ) {}

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
  async completeExport() {
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
  async open() {
    return Readable.from([]);
  }
  async create(): Promise<LifecycleArtifactWriterPort> {
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
