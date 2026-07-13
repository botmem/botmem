export type OwnTracksErrorCode =
  | 'OWNTRACKS_AUTH_FAILED'
  | 'OWNTRACKS_DNS_FAILED'
  | 'OWNTRACKS_ENDPOINT_REJECTED'
  | 'OWNTRACKS_INVALID_CURSOR'
  | 'OWNTRACKS_INVALID_RESPONSE'
  | 'OWNTRACKS_PAGE_LIMIT_EXCEEDED'
  | 'OWNTRACKS_PROVIDER_UNAVAILABLE'
  | 'OWNTRACKS_REDIRECT_REJECTED'
  | 'OWNTRACKS_RESPONSE_TOO_LARGE'
  | 'OWNTRACKS_SYNC_FAILED';

export class OwnTracksConnectorError extends Error {
  public constructor(
    public readonly code: OwnTracksErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class OwnTracksEndpointRejectedError extends OwnTracksConnectorError {
  public constructor() {
    super(
      'OWNTRACKS_ENDPOINT_REJECTED',
      'OwnTracks endpoint must be a permitted public HTTPS destination',
      false,
    );
  }
}

export class OwnTracksDnsError extends OwnTracksConnectorError {
  public constructor() {
    super('OWNTRACKS_DNS_FAILED', 'OwnTracks endpoint DNS resolution failed safely', true);
  }
}

export class OwnTracksRedirectError extends OwnTracksConnectorError {
  public constructor() {
    super(
      'OWNTRACKS_REDIRECT_REJECTED',
      'OwnTracks endpoint returned an unsafe or unsupported redirect',
      false,
    );
  }
}

export class OwnTracksInvalidCursorError extends OwnTracksConnectorError {
  public constructor() {
    super(
      'OWNTRACKS_INVALID_CURSOR',
      'OwnTracks cursor is malformed or from an unsupported version',
      false,
    );
  }
}

export class OwnTracksPageLimitError extends OwnTracksConnectorError {
  public constructor() {
    super(
      'OWNTRACKS_PAGE_LIMIT_EXCEEDED',
      'OwnTracks pagination exceeded its bounded safety limit',
      false,
    );
  }
}

export type OwnTracksProviderFailure =
  | 'auth_failed'
  | 'invalid_response'
  | 'response_too_large'
  | 'unavailable';

export class OwnTracksProviderError extends Error {
  public constructor(
    public readonly failure: OwnTracksProviderFailure,
    public readonly retryable: boolean,
  ) {
    super(`OwnTracks provider request failed: ${failure}`);
    this.name = 'OwnTracksProviderError';
  }
}

export type OwnTracksTransportFailure = 'network' | 'response_too_large' | 'timeout';

export class OwnTracksTransportError extends Error {
  public constructor(public readonly failure: OwnTracksTransportFailure) {
    super(`OwnTracks HTTPS transport failed: ${failure}`);
    this.name = 'OwnTracksTransportError';
  }
}
