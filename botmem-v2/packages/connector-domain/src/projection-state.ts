import {
  IdempotencyConflictError,
  InvalidDomainValueError,
  ProjectionLeaseConflictError,
} from './errors.js';
import { isoTimestamp, nonEmpty, sha256, type IngestRevisionId } from './value-objects.js';

export type ProjectionStatus = 'pending' | 'processing' | 'applied' | 'failed';

export interface ProjectionLease {
  readonly workerId: string;
  readonly expiresAt: string;
}

export interface ProjectionSnapshot {
  readonly projectionName: string;
  readonly revisionId: IngestRevisionId;
  readonly status: ProjectionStatus;
  readonly attempts: number;
  readonly lease: ProjectionLease | null;
  readonly outputHash: string | null;
  readonly lastErrorCode: string | null;
  readonly appliedAt: string | null;
}

export class ProjectionState {
  private constructor(private readonly state: ProjectionSnapshot) {}

  public static pending(projectionName: string, revisionId: IngestRevisionId): ProjectionState {
    return new ProjectionState(
      Object.freeze({
        projectionName: nonEmpty(projectionName, 'projectionName', 128),
        revisionId,
        status: 'pending',
        attempts: 0,
        lease: null,
        outputHash: null,
        lastErrorCode: null,
        appliedAt: null,
      }),
    );
  }

  public static rehydrate(snapshot: ProjectionSnapshot): ProjectionState {
    if (!Number.isInteger(snapshot.attempts) || snapshot.attempts < 0) {
      throw new InvalidDomainValueError('projection attempts must be a non-negative integer');
    }
    if (snapshot.lease) {
      nonEmpty(snapshot.lease.workerId, 'workerId', 128);
      isoTimestamp(snapshot.lease.expiresAt, 'lease.expiresAt');
    }
    if (snapshot.outputHash) {
      sha256(snapshot.outputHash, 'outputHash');
    }
    return new ProjectionState(Object.freeze({ ...snapshot }));
  }

  public snapshot(): ProjectionSnapshot {
    return this.state;
  }

  public claim(workerId: string, now: string, expiresAt: string): ProjectionState {
    const normalizedWorkerId = nonEmpty(workerId, 'workerId', 128);
    isoTimestamp(now, 'now');
    isoTimestamp(expiresAt, 'expiresAt');
    if (Date.parse(expiresAt) <= Date.parse(now)) {
      throw new InvalidDomainValueError('projection lease must expire after it starts');
    }
    if (this.state.status === 'applied') {
      return this;
    }
    if (
      this.state.lease &&
      this.state.lease.workerId !== normalizedWorkerId &&
      Date.parse(this.state.lease.expiresAt) > Date.parse(now)
    ) {
      throw new ProjectionLeaseConflictError();
    }
    return new ProjectionState(
      Object.freeze({
        ...this.state,
        status: 'processing',
        attempts: this.state.attempts + 1,
        lease: Object.freeze({ workerId: normalizedWorkerId, expiresAt }),
        lastErrorCode: null,
      }),
    );
  }

  public markApplied(workerId: string, outputHash: string, appliedAt: string): ProjectionState {
    const normalizedHash = sha256(outputHash, 'outputHash');
    isoTimestamp(appliedAt, 'appliedAt');
    if (this.state.status === 'applied') {
      if (this.state.outputHash !== normalizedHash) {
        throw new IdempotencyConflictError();
      }
      return this;
    }
    this.assertLeaseOwner(workerId);
    return new ProjectionState(
      Object.freeze({
        ...this.state,
        status: 'applied',
        lease: null,
        outputHash: normalizedHash,
        lastErrorCode: null,
        appliedAt,
      }),
    );
  }

  public markFailed(workerId: string, errorCode: string): ProjectionState {
    this.assertLeaseOwner(workerId);
    return new ProjectionState(
      Object.freeze({
        ...this.state,
        status: 'failed',
        lease: null,
        lastErrorCode: nonEmpty(errorCode, 'errorCode', 128),
      }),
    );
  }

  private assertLeaseOwner(workerId: string): void {
    if (this.state.status !== 'processing' || this.state.lease?.workerId !== workerId) {
      throw new ProjectionLeaseConflictError();
    }
  }
}
