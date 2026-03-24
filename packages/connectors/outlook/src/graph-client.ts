/**
 * Thin Microsoft Graph API client with token refresh and rate limit handling.
 *
 * NOTE (SDK audit): The connector SDK provides no HTTP client helper. For OAuth2
 * connectors that don't use a provider SDK (like googleapis), you need to handle:
 * - Authorization header injection
 * - 401 → token refresh → retry
 * - 429 → exponential backoff
 * - AbortSignal propagation
 *
 * The Gmail connector avoids this by using the googleapis package which handles
 * token refresh internally. External devs building connectors for services without
 * a comprehensive SDK (like Microsoft Graph) must build this themselves. The docs
 * should either provide a helper or document this pattern.
 */

import type { OutlookOAuthConfig } from './oauth.js';
import { refreshOutlookToken } from './oauth.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const MAX_RETRIES = 3;

export interface GraphClientOptions {
  accessToken: string;
  refreshToken?: string;
  oauthConfig: OutlookOAuthConfig;
  signal?: AbortSignal;
  onTokenRefresh?: (newAccessToken: string) => void;
}

export class GraphClient {
  private accessToken: string;
  private refreshToken?: string;
  private oauthConfig: OutlookOAuthConfig;
  private signal?: AbortSignal;
  private onTokenRefresh?: (newAccessToken: string) => void;

  constructor(options: GraphClientOptions) {
    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
    this.oauthConfig = options.oauthConfig;
    this.signal = options.signal;
    this.onTokenRefresh = options.onTokenRefresh;
  }

  /**
   * Make a GET request to the Graph API.
   * Handles full URLs (for @odata.nextLink pagination) and relative paths.
   */
  async get<T>(urlOrPath: string): Promise<T> {
    const url = urlOrPath.startsWith('http')
      ? urlOrPath
      : `${GRAPH_BASE}${urlOrPath.startsWith('/') ? '' : '/'}${urlOrPath}`;

    return this.fetchWithRetry(url);
  }

  private async fetchWithRetry<T>(url: string, attempt = 0): Promise<T> {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
      signal: this.signal,
    });

    // Handle token expiration — refresh and retry once
    if (res.status === 401 && this.refreshToken && attempt === 0) {
      const tokens = await refreshOutlookToken(
        this.oauthConfig,
        this.refreshToken,
        this.signal,
      );
      this.accessToken = tokens.access_token;
      if (tokens.refresh_token) {
        this.refreshToken = tokens.refresh_token;
      }
      this.onTokenRefresh?.(tokens.access_token);
      return this.fetchWithRetry(url, attempt + 1);
    }

    // Handle rate limiting with exponential backoff
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '1', 10);
      const delay = retryAfter * 1000 * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return this.fetchWithRetry(url, attempt + 1);
    }

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Graph API error ${res.status}: ${error}`);
    }

    return res.json();
  }
}
