export type OutlookErrorCode =
  | 'OUTLOOK_AUTH_REVOKED'
  | 'OUTLOOK_FULL_RESYNC_REQUIRED'
  | 'OUTLOOK_INVALID_CURSOR'
  | 'OUTLOOK_INVALID_OAUTH_CALLBACK'
  | 'OUTLOOK_INVALID_PROVIDER_RESPONSE'
  | 'OUTLOOK_OAUTH_STATE_INVALID'
  | 'OUTLOOK_PAGE_LIMIT_EXCEEDED'
  | 'OUTLOOK_PROVIDER_UNAVAILABLE'
  | 'OUTLOOK_SYNC_FAILED';

export class OutlookConnectorError extends Error {
  public constructor(
    public readonly code: OutlookErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class OutlookOAuthStateError extends OutlookConnectorError {
  public constructor() {
    super('OUTLOOK_OAUTH_STATE_INVALID', 'OAuth state is invalid, expired, or already used', false);
  }
}

export class OutlookOAuthCallbackError extends OutlookConnectorError {
  public constructor() {
    super(
      'OUTLOOK_INVALID_OAUTH_CALLBACK',
      'Microsoft did not return a usable authorization code and required scope set',
      false,
    );
  }
}

export class OutlookReconnectRequiredError extends OutlookConnectorError {
  public constructor() {
    super('OUTLOOK_AUTH_REVOKED', 'Microsoft authorization must be reconnected', false);
  }
}

export class OutlookFullResyncRequiredError extends OutlookConnectorError {
  public constructor() {
    super(
      'OUTLOOK_FULL_RESYNC_REQUIRED',
      'Microsoft no longer accepts the stored delta cursor; an explicit full resync is required',
      false,
    );
  }
}

export class OutlookInvalidCursorError extends OutlookConnectorError {
  public constructor() {
    super(
      'OUTLOOK_INVALID_CURSOR',
      'Outlook cursor is malformed or from an unsupported version',
      false,
    );
  }
}

export class OutlookPageLimitError extends OutlookConnectorError {
  public constructor() {
    super('OUTLOOK_PAGE_LIMIT_EXCEEDED', 'Outlook pagination exceeded the safety limit', false);
  }
}

export type OutlookProviderFailure =
  | 'invalid_delta'
  | 'invalid_grant'
  | 'invalid_response'
  | 'rate_limited'
  | 'response_too_large'
  | 'revoked'
  | 'unavailable';

/**
 * Provider errors deliberately carry no URL, response body, token, message data,
 * or participant value. Adapters may log only `failure` and `status`.
 */
export class OutlookProviderError extends Error {
  public constructor(
    public readonly failure: OutlookProviderFailure,
    public readonly status: number | null = null,
  ) {
    super(`Outlook provider request failed: ${failure}`);
    this.name = 'OutlookProviderError';
  }
}
