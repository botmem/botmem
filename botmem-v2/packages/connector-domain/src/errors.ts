export type ConnectorDomainErrorCode =
  | 'ACCOUNT_NOT_FOUND'
  | 'CONCURRENT_SYNC'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_DOMAIN_VALUE'
  | 'OPTIMISTIC_CONCURRENCY_CONFLICT'
  | 'PROJECTION_LEASE_CONFLICT'
  | 'SYNC_NOT_ALLOWED'
  | 'SYNC_OWNERSHIP_CONFLICT';

export class ConnectorDomainError extends Error {
  public constructor(
    public readonly code: ConnectorDomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidDomainValueError extends ConnectorDomainError {
  public constructor(message: string) {
    super('INVALID_DOMAIN_VALUE', message);
  }
}

export class AccountNotFoundError extends ConnectorDomainError {
  public constructor() {
    super('ACCOUNT_NOT_FOUND', 'connector account was not found in the tenant scope');
  }
}

export class ConcurrentSyncError extends ConnectorDomainError {
  public constructor() {
    super('CONCURRENT_SYNC', 'connector account already has an active sync');
  }
}

export class SyncNotAllowedError extends ConnectorDomainError {
  public constructor() {
    super('SYNC_NOT_ALLOWED', 'connector account is not ready to sync');
  }
}

export class SyncOwnershipError extends ConnectorDomainError {
  public constructor() {
    super('SYNC_OWNERSHIP_CONFLICT', 'sync attempt does not own the connector lease');
  }
}

export class OptimisticConcurrencyError extends ConnectorDomainError {
  public constructor() {
    super(
      'OPTIMISTIC_CONCURRENCY_CONFLICT',
      'connector account or cursor changed after it was read',
    );
  }
}

export class IdempotencyConflictError extends ConnectorDomainError {
  public constructor() {
    super(
      'IDEMPOTENCY_CONFLICT',
      'the same source revision was observed with different immutable content',
    );
  }
}

export class ProjectionLeaseConflictError extends ConnectorDomainError {
  public constructor() {
    super('PROJECTION_LEASE_CONFLICT', 'projection is leased by another worker');
  }
}
