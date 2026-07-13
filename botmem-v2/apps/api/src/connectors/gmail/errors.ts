export type GmailErrorCode =
  | 'GMAIL_AUTH_REVOKED'
  | 'GMAIL_FULL_RESYNC_REQUIRED'
  | 'GMAIL_INVALID_CURSOR'
  | 'GMAIL_INVALID_OAUTH_CALLBACK'
  | 'GMAIL_INVALID_PROVIDER_RESPONSE'
  | 'GMAIL_OAUTH_STATE_INVALID'
  | 'GMAIL_PAGE_LIMIT_EXCEEDED'
  | 'GMAIL_PROVIDER_UNAVAILABLE'
  | 'GMAIL_SYNC_FAILED';

export class GmailConnectorError extends Error {
  public constructor(
    public readonly code: GmailErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class GmailOAuthStateError extends GmailConnectorError {
  public constructor() {
    super('GMAIL_OAUTH_STATE_INVALID', 'OAuth state is invalid, expired, or already used', false);
  }
}

export class GmailOAuthCallbackError extends GmailConnectorError {
  public constructor() {
    super(
      'GMAIL_INVALID_OAUTH_CALLBACK',
      'Google did not return a usable authorization code',
      false,
    );
  }
}

export class GmailReconnectRequiredError extends GmailConnectorError {
  public constructor() {
    super('GMAIL_AUTH_REVOKED', 'Google authorization must be reconnected', false);
  }
}

export class GmailFullResyncRequiredError extends GmailConnectorError {
  public constructor() {
    super(
      'GMAIL_FULL_RESYNC_REQUIRED',
      'Google no longer retains the requested history cursor; a full resync is required',
      false,
    );
  }
}

export class GmailInvalidCursorError extends GmailConnectorError {
  public constructor() {
    super(
      'GMAIL_INVALID_CURSOR',
      'Gmail cursor is malformed or from an unsupported version',
      false,
    );
  }
}

export class GmailPageLimitError extends GmailConnectorError {
  public constructor() {
    super('GMAIL_PAGE_LIMIT_EXCEEDED', 'Gmail pagination exceeded the safety limit', false);
  }
}

export type GmailProviderFailure =
  | 'history_expired'
  | 'invalid_response'
  | 'rate_limited'
  | 'response_too_large'
  | 'revoked'
  | 'unavailable';

export class GmailProviderError extends Error {
  public constructor(
    public readonly failure: GmailProviderFailure,
    public readonly status: number | null = null,
  ) {
    super(`Gmail provider request failed: ${failure}`);
    this.name = 'GmailProviderError';
  }
}
