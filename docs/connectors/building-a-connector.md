# Building a Custom Connector

This guide walks through creating a complete Botmem connector from scratch. By the end, you will have a working connector that can authenticate, sync data, and integrate with the full pipeline.

## Directory Structure

Create a new package under `packages/connectors/`:

```
packages/connectors/my-source/
  package.json
  src/
    index.ts       # Main connector class + default export
  tsconfig.json
```

## 1. Package Setup

```json
{
  "name": "@botmem/connector-my-source",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@botmem/connector-sdk": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

## 2. Implement the Connector

Here is a complete example connector that imports notes from a hypothetical REST API using **api-key** auth:

```typescript
// packages/connectors/my-source/src/index.ts

import { BaseConnector } from '@botmem/connector-sdk';
import type {
  ConnectorManifest,
  AuthContext,
  AuthInitResult,
  SyncContext,
  SyncResult,
  ConnectorDataEvent,
} from '@botmem/connector-sdk';

interface NoteApiResponse {
  id: string;
  title: string;
  body: string;
  author: string;
  createdAt: string;
  tags: string[];
}

export class MySourceConnector extends BaseConnector {
  // ── Manifest ──────────────────────────────────────────────
  // Describes the connector to the UI and registry.

  readonly manifest: ConnectorManifest = {
    id: 'my-source',
    name: 'My Notes',
    description: 'Import notes from My Notes API',
    color: '#10B981', // Brand color for UI
    icon: 'notebook', // Icon name for UI
    authType: 'api-key', // One of: oauth2, qr-code, phone-code, api-key, local-tool
    configSchema: {
      type: 'object',
      properties: {
        apiUrl: {
          type: 'string',
          title: 'API URL',
          description: 'Base URL of the My Notes API',
        },
        apiKey: {
          type: 'string',
          title: 'API Key',
          description: 'Your API key from My Notes settings',
        },
      },
      required: ['apiUrl', 'apiKey'],
    },

    // Entity types this connector produces
    entities: ['message'],

    // Pipeline stages — all enabled by default
    pipeline: { clean: true, embed: true, enrich: true },

    // Base trust score (0-1). Higher = more trusted source.
    trustScore: 0.85,

    // Optional: override default scoring weights
    // weights: { semantic: 0.40, recency: 0.25, importance: 0.20, trust: 0.15 },
  };

  // ── Authentication ────────────────────────────────────────

  async initiateAuth(config: Record<string, unknown>): Promise<AuthInitResult> {
    // For api-key auth, we can complete immediately.
    // Validate that the API key works before accepting it.
    const apiUrl = config.apiUrl as string;
    const apiKey = config.apiKey as string;

    const res = await fetch(`${apiUrl}/api/me`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      throw new Error(`Invalid API key: ${res.status} ${res.statusText}`);
    }

    const profile = await res.json();

    return {
      type: 'complete',
      auth: {
        accessToken: apiKey,
        identifier: profile.email || profile.username,
        raw: { apiUrl, apiKey },
      },
    };
  }

  async completeAuth(params: Record<string, unknown>): Promise<AuthContext> {
    // For api-key auth, initiateAuth already returns the full context.
    // This method is called for OAuth flows after the redirect callback.
    return params as AuthContext;
  }

  async validateAuth(auth: AuthContext): Promise<boolean> {
    const apiUrl = auth.raw?.apiUrl as string;
    if (!apiUrl || !auth.accessToken) return false;

    try {
      const res = await fetch(`${apiUrl}/api/me`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async revokeAuth(auth: AuthContext): Promise<void> {
    // If the API supports token revocation, do it here.
    // Otherwise, this can be a no-op.
  }

  // ── Sync ──────────────────────────────────────────────────

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const apiUrl = ctx.auth.raw?.apiUrl as string;
    const apiKey = ctx.auth.accessToken;

    if (!apiUrl || !apiKey) {
      throw new Error('Missing API URL or key in auth context');
    }

    let page = 1;
    let processed = 0;
    let hasMore = true;

    // Resume from cursor if available (page number for this example)
    if (ctx.cursor) {
      page = parseInt(ctx.cursor, 10) || 1;
    }

    while (hasMore) {
      // Check if the sync was cancelled
      if (ctx.signal.aborted) {
        ctx.logger.info('Sync aborted by user');
        break;
      }

      // Fetch a page of notes
      ctx.logger.info(`Fetching page ${page}...`);
      const res = await fetch(`${apiUrl}/api/notes?page=${page}&limit=50`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctx.signal,
      });

      if (!res.ok) {
        throw new Error(`API error: ${res.status} ${res.statusText}`);
      }

      const data = await res.json();
      const notes: NoteApiResponse[] = data.notes;

      if (!notes.length) {
        hasMore = false;
        break;
      }

      // Emit each note as a ConnectorDataEvent
      for (const note of notes) {
        const event: ConnectorDataEvent = {
          sourceType: 'message', // Use the closest matching type
          sourceId: note.id, // Unique ID from the source
          timestamp: note.createdAt,
          content: {
            text: `${note.title}\n\n${note.body}`,
            participants: [note.author],
            metadata: {
              title: note.title,
              tags: note.tags,
              sourceUrl: `${apiUrl}/notes/${note.id}`,
            },
          },
        };

        // emitData() returns false if the debug sync limit is reached
        if (!this.emitData(event)) {
          break;
        }
        processed++;
      }

      // Emit progress for the UI
      this.emitProgress({
        processed,
        total: data.totalCount,
      });

      // Check for more pages
      hasMore = data.hasNextPage;
      page++;

      // Check if debug limit was reached
      if (this.isLimitReached) break;
    }

    return {
      cursor: String(page), // Save cursor for next incremental sync
      hasMore,
      processed,
    };
  }
}

// Default export: a factory function that returns a new instance.
// IMPORTANT: Must be a factory function, not a singleton instance.
export default () => new MySourceConnector();
```

## 3. OAuth2 Connector Example

Most real-world connectors use OAuth2 (Gmail, Slack, Outlook, etc.). Here is a complete OAuth2 auth flow example:

```typescript
import { BaseConnector } from '@botmem/connector-sdk';
import type {
  ConnectorManifest,
  AuthContext,
  AuthInitResult,
  OAuth2CompleteParams,
  SyncContext,
  SyncResult,
} from '@botmem/connector-sdk';

export class MyOAuth2Connector extends BaseConnector {
  // Store config between initiateAuth() and completeAuth()
  private _pendingConfig: Record<string, unknown> = {};

  readonly manifest: ConnectorManifest = {
    id: 'my-oauth2',
    name: 'My Service',
    description: 'Import data from My Service via OAuth2',
    color: '#4285F4',
    icon: 'cloud',
    authType: 'oauth2',
    configSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string', title: 'Client ID' },
        clientSecret: { type: 'string', title: 'Client Secret' },
      },
      required: ['clientId', 'clientSecret'],
    },
    entities: ['email', 'contact'],
    pipeline: { clean: true, embed: true, enrich: true },
    trustScore: 0.9,
  };

  async initiateAuth(config: Record<string, unknown>): Promise<AuthInitResult> {
    const clientId = config.clientId as string;
    const redirectUri = 'http://localhost:12412/api/auth/my-oauth2/callback';

    // Store config for completeAuth() to use later
    this._pendingConfig = { ...config, redirectUri };

    // Build the authorization URL
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'read write',
      access_type: 'offline', // Request refresh token
      prompt: 'consent', // Force consent to get refresh token
    });

    return {
      type: 'redirect',
      url: `https://auth.myservice.com/authorize?${params}`,
    };
  }

  async completeAuth(params: Record<string, unknown>): Promise<AuthContext> {
    // params contains the authorization code from the redirect callback
    const { code } = params as OAuth2CompleteParams;

    // Use stored config, or fall back to params (in case of different instance)
    const config = { ...this._pendingConfig, ...params };
    const clientId = config.clientId as string;
    const clientSecret = config.clientSecret as string;
    const redirectUri = config.redirectUri as string;

    // Exchange authorization code for tokens
    const tokenRes = await fetch('https://auth.myservice.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${tokenRes.status}`);
    }

    const tokens = await tokenRes.json();

    // Fetch user profile for identifier
    const profileRes = await fetch('https://api.myservice.com/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = profileRes.ok ? await profileRes.json() : {};

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      identifier: profile.email,
      // IMPORTANT: Store OAuth client config in auth.raw so sync() can
      // reconstruct the OAuth client later for token refresh.
      raw: { clientId, clientSecret, redirectUri },
    };
  }

  async validateAuth(auth: AuthContext): Promise<boolean> {
    if (!auth.accessToken) return false;
    try {
      const res = await fetch('https://api.myservice.com/me', {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async revokeAuth(auth: AuthContext): Promise<void> {
    if (auth.accessToken) {
      await fetch(`https://auth.myservice.com/revoke?token=${auth.accessToken}`).catch(() => {});
    }
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    // Reconstruct OAuth client from auth.raw for token refresh
    const { clientId, clientSecret } = ctx.auth.raw as {
      clientId: string;
      clientSecret: string;
    };

    let accessToken = ctx.auth.accessToken!;

    // Helper: refresh token if expired
    const refreshIfNeeded = async () => {
      if (ctx.auth.expiresAt && new Date(ctx.auth.expiresAt) < new Date()) {
        const res = await fetch('https://auth.myservice.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: ctx.auth.refreshToken!,
            client_id: clientId,
            client_secret: clientSecret,
          }),
        });
        if (res.ok) {
          const tokens = await res.json();
          accessToken = tokens.access_token;
          ctx.auth.accessToken = accessToken;
          ctx.auth.expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
          ctx.logger.info('Refreshed access token');
        }
      }
    };

    await refreshIfNeeded();

    // ... fetch data using accessToken, emit events ...

    return { cursor: null, hasMore: false, processed: 0 };
  }
}

export default () => new MyOAuth2Connector();
```

### Key Points for OAuth2 Connectors

1. **`initiateAuth()`** builds the authorization URL and returns `{ type: 'redirect', url }`. Store the client config in an instance variable for `completeAuth()`.
2. **`completeAuth(params)`** receives the authorization code from the callback. Exchange it for tokens, fetch the user profile, and return the `AuthContext`. Store `clientId`, `clientSecret`, and `redirectUri` in `auth.raw`.
3. **Token refresh during sync**: Access tokens expire (typically 1 hour). For large syncs, detect 401 responses or check `expiresAt`, then use the refresh token to get a new access token. Rebuild the OAuth client from `auth.raw`.

## 4. Emitting Contact Data

Connectors that import contacts (Gmail, Outlook, Slack) use `sourceType: 'contact'` and the `ContactEventMetadata` convention:

```typescript
import type { ConnectorDataEvent, ContactEventMetadata } from '@botmem/connector-sdk';

const event: ConnectorDataEvent = {
  sourceType: 'contact',
  sourceId: `my-contact-${contact.id}`,
  timestamp: contact.updatedAt || new Date().toISOString(),
  content: {
    text: [contact.name, contact.email, contact.company].filter(Boolean).join('\n'),
    participants: [contact.name, ...contact.emails].filter(Boolean),
    metadata: {
      type: 'contact',
      name: contact.name,
      givenName: contact.firstName,
      familyName: contact.lastName,
      emails: contact.emails,
      phones: contact.phones,
      organizations: [{ name: contact.company, title: contact.jobTitle }],
    } satisfies ContactEventMetadata,
  },
};

this.emitData(event);
```

Contact events are processed differently from regular events — they resolve to the `contacts` table without creating a memory record.

## 5. Register the Connector

Register your connector in the plugin system. This requires updating **4 files**:

### 5a. Plugin loader

In `apps/api/src/plugins/plugins.service.ts`, add a `loadBuiltin()` call:

```typescript
await this.loadBuiltin('@botmem/connector-my-source');
```

### 5b. Shared types

In `packages/shared/src/types/index.ts`, add to the `BuiltinConnectorType` union:

```typescript
export type BuiltinConnectorType = 'gmail' | 'slack' | 'whatsapp' | /* ... */ | 'my-source';
```

### 5c. Connector colors

In `packages/shared/src/utils/index.ts`, add to the `CONNECTOR_COLORS` map:

```typescript
'my-source': '#10B981',
```

### 5d. Frontend metadata

In `apps/web/src/lib/connectorMeta.ts`, add icon and label:

```typescript
// In CONNECTOR_ICONS:
'my-source': 'Mn',  // 2-letter abbreviation for the UI

// In CONNECTOR_LABELS:
'my-source': 'My Notes',
```

### 5e. Add workspace dependency

Add the package reference in the API's `package.json`:

```json
{
  "dependencies": {
    "@botmem/connector-my-source": "workspace:*"
  }
}
```

Then run `pnpm install` to link the workspace package.

## Key Concepts

### ConnectorDataEvent

Every piece of data you emit must be a `ConnectorDataEvent`:

```typescript
interface ConnectorDataEvent {
  sourceType: 'email' | 'message' | 'contact' | 'photo' | 'location' | 'file';
  sourceId: string; // Unique ID from the external service
  timestamp: string; // ISO 8601
  content: {
    text?: string; // The text content to embed and search
    participants?: string[]; // People involved (for contact resolution)
    attachments?: Array<{
      uri: string;
      mimeType: string;
      filename?: string; // Original filename
      size?: number; // File size in bytes
    }>;
    metadata: Record<string, unknown>; // Connector-specific data
  };
}
```

### Source Types

Choose the `sourceType` that best matches your data:

| Type       | Use For                             | Examples                        |
| ---------- | ----------------------------------- | ------------------------------- |
| `email`    | Email-like messages with from/to/cc | Email clients, newsletters      |
| `message`  | Chat messages, DMs, comments        | Chat apps, forums, comments     |
| `contact`  | People/contacts with metadata       | Address books, user profiles    |
| `photo`    | Images with metadata                | Photo libraries, screenshots    |
| `location` | GPS coordinates                     | Location trackers, check-ins    |
| `file`     | Documents, spreadsheets, PDFs       | File storage, document managers |

### Auth Types

| Type         | Flow                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth2`     | `initiateAuth` returns `{ type: 'redirect', url }`, user is redirected, `completeAuth` receives the authorization code and exchanges it for tokens |
| `qr-code`    | `initiateAuth` returns `{ type: 'qr-code', qrData, wsChannel }`, QR is shown in UI, auth completes over WebSocket                                  |
| `phone-code` | `initiateAuth` returns `{ type: 'phone-code', phoneCodeHash, wsChannel }`, user enters code sent to their phone                                    |
| `api-key`    | `initiateAuth` returns `{ type: 'complete', auth }` immediately after validating credentials                                                       |
| `local-tool` | `initiateAuth` returns `{ type: 'complete', auth }` with no credentials needed (reads local data)                                                  |

### `completeAuth(params)` Shape by Auth Type

| Auth Type    | `params` contains                                                                       |
| ------------ | --------------------------------------------------------------------------------------- |
| `oauth2`     | `{ code, state?, clientId?, clientSecret?, redirectUri? }` — see `OAuth2CompleteParams` |
| `qr-code`    | Session data from the WebSocket channel                                                 |
| `phone-code` | `{ code, phoneCodeHash }`                                                               |
| `api-key`    | The `AuthContext` from `initiateAuth()` (usually a passthrough)                         |
| `local-tool` | The `AuthContext` from `initiateAuth()`                                                 |

### Cursor Strategies

The `cursor` in `SyncContext` is a string that your connector controls. Use it to track pagination state so that subsequent syncs only fetch new data. Common strategies:

| Strategy              | Use When                                           | Example                           |
| --------------------- | -------------------------------------------------- | --------------------------------- |
| **Timestamp-based**   | API supports filtering by date                     | `cursor = lastEvent.timestamp`    |
| **Page-token-based**  | API returns pagination tokens                      | `cursor = response.nextPageToken` |
| **Delta-token-based** | API supports delta queries (e.g., Microsoft Graph) | `cursor = response.deltaLink`     |

The cursor is stored in the account record and passed back on the next sync.

### Abort Signal

Always respect `ctx.signal`. Pass it to `fetch()` calls and check `ctx.signal.aborted` in loops. This allows users to cancel long-running syncs.

### Debug Sync Limit

`BaseConnector.DEBUG_SYNC_LIMIT` (default 0 / disabled) limits the number of events emitted during development. When enabled, `emitData()` returns `false` after the limit is reached. Always check the return value.

::: warning
`emitData()` returns `false` both when the debug limit is reached AND when there are no registered `data` event listeners. In tests, always add a `connector.on('data', ...)` listener before calling `sync()`.
:::

### Default Export

The default export **must** be a factory function that returns a new connector instance:

```typescript
export default () => new MySourceConnector();
```

Do **not** export a singleton (`export default new MySourceConnector()`). The plugin system calls the factory to create fresh instances.

### Pipeline Customization

Connectors can override pipeline methods to customize how data is processed. See the [SDK Reference](/contributing/connector-sdk#pipeline-override-methods) for details on `clean()`, `embed()`, `enrich()`, and `extractFile()`.

### Logging

Use `ctx.logger` for structured logging:

```typescript
ctx.logger.info('Starting sync...');
ctx.logger.warn('Rate limited, retrying in 5s');
ctx.logger.error('API returned 500');
ctx.logger.debug('Fetched 50 notes');
```

Logs are stored in the database and visible in the web UI.

### NestJS Watch Mode Caveat

When running `pnpm dev`, NestJS watch mode does **not** detect changes in external workspace packages (like your connector). After modifying connector source, you must restart the dev server for changes to take effect.

## 6. Testing

Create tests in `packages/connectors/my-source/src/__tests__/`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { MySourceConnector } from '../index.js';

describe('MySourceConnector', () => {
  it('has correct manifest', () => {
    const connector = new MySourceConnector();
    expect(connector.manifest.id).toBe('my-source');
    expect(connector.manifest.authType).toBe('api-key');
    expect(connector.manifest.entities).toEqual(['message']);
    expect(connector.manifest.trustScore).toBe(0.85);
  });

  it('emits data events during sync', async () => {
    const connector = new MySourceConnector();
    const events: any[] = [];
    // IMPORTANT: Always add a 'data' listener before sync — emitData()
    // returns false when no listeners are registered.
    connector.on('data', (event) => events.push(event));

    // Mock the fetch calls
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        notes: [
          {
            id: '1',
            title: 'Test',
            body: 'Hello',
            author: 'user',
            createdAt: '2026-01-01T00:00:00Z',
            tags: [],
          },
        ],
        hasNextPage: false,
        totalCount: 1,
      }),
    });

    const result = await connector.sync({
      accountId: 'test',
      auth: { accessToken: 'key', raw: { apiUrl: 'http://localhost' } },
      cursor: null,
      jobId: 'job-1',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      signal: new AbortController().signal,
    });

    expect(events).toHaveLength(1);
    expect(events[0].sourceId).toBe('1');
    expect(result.processed).toBe(1);
  });
});
```

## Complete Connector Checklist

- [ ] `manifest` with all required fields: `id`, `name`, `authType`, `configSchema`, `entities`, `pipeline`, `trustScore`
- [ ] `initiateAuth()` validates credentials and returns the appropriate result type
- [ ] `completeAuth()` handles the auth flow completion (OAuth callback, etc.)
- [ ] `validateAuth()` checks if stored credentials are still valid
- [ ] `revokeAuth()` cleans up credentials when disconnecting
- [ ] `sync()` fetches data, emits events, respects the abort signal, and returns a cursor
- [ ] All `fetch()` calls pass `ctx.signal` for cancellation support
- [ ] `emitData()` return value is checked (for debug sync limit)
- [ ] Progress events are emitted for UI feedback
- [ ] Tests cover the happy path and error cases (with `data` listener attached)
- [ ] Default export is a factory function
- [ ] Registered in all 4 files: `plugins.service.ts`, shared types, shared utils, frontend connectorMeta
