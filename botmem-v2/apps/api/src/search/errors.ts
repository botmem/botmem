export type HostedSearchFailureCode =
  | 'search_aborted'
  | 'embedding_invalid'
  | 'embedding_profile_indexing'
  | 'embedding_profile_error'
  | 'embedding_profile_mismatch'
  | 'projection_input_mismatch'
  | 'projection_lease_conflict'
  | 'projection_idempotency_conflict'
  | 'search_probe_rejected';

export class HostedSearchFailure extends Error {
  constructor(readonly code: HostedSearchFailureCode) {
    super(code);
    this.name = 'HostedSearchFailure';
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new HostedSearchFailure('search_aborted');
}
