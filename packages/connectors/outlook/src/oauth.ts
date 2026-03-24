/**
 * Microsoft OAuth2 helpers for Outlook connector.
 *
 * NOTE (SDK audit): The connector SDK docs provide ZERO guidance on implementing
 * OAuth2 flows. The "Building a Connector" guide only shows an api-key example.
 * Everything here was figured out from Microsoft identity platform docs alone.
 * The SDK docs should include an OAuth2 connector example.
 */

const MICROSOFT_AUTH_BASE = 'https://login.microsoftonline.com';
const SCOPES = 'Mail.Read Contacts.Read User.Read offline_access';

export interface OutlookOAuthConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  redirectUri: string;
}

export interface OutlookTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

/**
 * Build the Microsoft OAuth2 authorization URL.
 *
 * NOTE (SDK audit): The docs say oauth2 auth returns { type: 'redirect', url }
 * but don't explain what query params are needed or how to construct the URL.
 * An external dev has to know their OAuth provider's auth endpoint format.
 */
export function getOutlookAuthUrl(config: OutlookOAuthConfig, state?: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    scope: SCOPES,
    response_mode: 'query',
  });

  if (state) {
    params.set('state', state);
  }

  return `${MICROSOFT_AUTH_BASE}/${config.tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 *
 * NOTE (SDK audit): The docs don't explain what params completeAuth() receives.
 * For OAuth2, we assume `params.code` contains the authorization code from the
 * callback. But does the system also pass the original config? We don't know
 * from docs alone — we have to store config in `auth.raw` during initiateAuth
 * or hope it comes back in completeAuth params.
 */
export async function exchangeOutlookCode(
  config: OutlookOAuthConfig,
  code: string,
  signal?: AbortSignal,
): Promise<OutlookTokens> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
    scope: SCOPES,
  });

  const res = await fetch(
    `${MICROSOFT_AUTH_BASE}/${config.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal,
    },
  );

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${error}`);
  }

  return res.json();
}

/**
 * Refresh an expired access token.
 *
 * NOTE (SDK audit): The docs don't mention token refresh at ALL. OAuth2 access
 * tokens expire (Microsoft's last ~1 hour). During a large email sync, the token
 * WILL expire mid-sync. The SDK provides no helper for this — connector authors
 * must handle 401 responses and refresh manually. This is a significant gap.
 */
export async function refreshOutlookToken(
  config: OutlookOAuthConfig,
  refreshToken: string,
  signal?: AbortSignal,
): Promise<OutlookTokens> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: SCOPES,
  });

  const res = await fetch(
    `${MICROSOFT_AUTH_BASE}/${config.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal,
    },
  );

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${error}`);
  }

  return res.json();
}
