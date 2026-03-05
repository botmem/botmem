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

Here is a complete example connector that imports notes from a hypothetical REST API:

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
    color: '#10B981',           // Brand color for UI
    icon: 'notebook',           // Icon name for UI
    authType: 'api-key',        // One of: oauth2, qr-code, api-key, local-tool
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
      const res = await fetch(
        `${apiUrl}/api/notes?page=${page}&limit=50`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: ctx.signal,
        },
      );

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
          sourceType: 'message',    // Use the closest matching type
          sourceId: note.id,        // Unique ID from the source
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
      cursor: String(page),   // Save cursor for next incremental sync
      hasMore,
      processed,
    };
  }
}

// Default export: a factory function that returns a new instance
export default () => new MySourceConnector();
```

## 3. Register the Connector

Add the connector to the registry in `apps/api/src/connectors/connectors.service.ts`:

```typescript
import mySourceFactory from '@botmem/connector-my-source';

// In the ConnectorsService constructor or init method:
this.register(mySourceFactory());
```

## 4. Add to Workspace

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
  sourceType: 'email' | 'message' | 'photo' | 'location' | 'file';
  sourceId: string;       // Unique ID from the external service
  timestamp: string;      // ISO 8601
  content: {
    text?: string;        // The text content to embed and search
    participants?: string[];  // People involved (for contact resolution)
    attachments?: Array<{ uri: string; mimeType: string }>;
    metadata: Record<string, unknown>;  // Connector-specific data
  };
}
```

### Source Types

Choose the `sourceType` that best matches your data:

| Type | Use For | Examples |
|---|---|---|
| `email` | Email-like messages with from/to/cc | Email clients, newsletters |
| `message` | Chat messages, DMs, comments | Chat apps, forums, comments |
| `photo` | Images with metadata | Photo libraries, screenshots |
| `location` | GPS coordinates | Location trackers, check-ins |
| `file` | Documents, spreadsheets, PDFs | File storage, document managers |

### Auth Types

| Type | Flow |
|---|---|
| `oauth2` | `initiateAuth` returns `{ type: 'redirect', url }`, user is redirected, `completeAuth` handles the callback |
| `qr-code` | `initiateAuth` returns `{ type: 'qr-code', qrData, wsChannel }`, QR is shown in UI |
| `api-key` | `initiateAuth` returns `{ type: 'complete', auth }` immediately |
| `local-tool` | `initiateAuth` returns `{ type: 'complete', auth }` with no credentials needed |

### Cursor-Based Sync

The `cursor` in `SyncContext` is a string that your connector controls. Use it to track pagination state so that subsequent syncs only fetch new data. The cursor is stored in the account record and passed back on the next sync.

### Abort Signal

Always respect `ctx.signal`. Pass it to `fetch()` calls and check `ctx.signal.aborted` in loops. This allows users to cancel long-running syncs.

### Debug Sync Limit

`BaseConnector.DEBUG_SYNC_LIMIT` (default 0 / disabled) limits the number of events emitted during development. When enabled, `emitData()` returns `false` after the limit is reached. Always check the return value.

### Logging

Use `ctx.logger` for structured logging:

```typescript
ctx.logger.info('Starting sync...');
ctx.logger.warn('Rate limited, retrying in 5s');
ctx.logger.error('API returned 500');
ctx.logger.debug('Fetched 50 notes');
```

Logs are stored in the database and visible in the web UI.

## 5. Testing

Create tests in `packages/connectors/my-source/src/__tests__/`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { MySourceConnector } from '../index.js';

describe('MySourceConnector', () => {
  it('has correct manifest', () => {
    const connector = new MySourceConnector();
    expect(connector.manifest.id).toBe('my-source');
    expect(connector.manifest.authType).toBe('api-key');
  });

  it('emits data events during sync', async () => {
    const connector = new MySourceConnector();
    const events: any[] = [];
    connector.on('data', (event) => events.push(event));

    // Mock the fetch calls
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          notes: [
            { id: '1', title: 'Test', body: 'Hello', author: 'user', createdAt: '2026-01-01T00:00:00Z', tags: [] },
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

- [ ] `manifest` with correct `id`, `name`, `authType`, and `configSchema`
- [ ] `initiateAuth()` validates credentials and returns the appropriate result type
- [ ] `completeAuth()` handles the auth flow completion (OAuth callback, etc.)
- [ ] `validateAuth()` checks if stored credentials are still valid
- [ ] `revokeAuth()` cleans up credentials when disconnecting
- [ ] `sync()` fetches data, emits events, respects the abort signal, and returns a cursor
- [ ] All `fetch()` calls pass `ctx.signal` for cancellation support
- [ ] `emitData()` return value is checked (for debug sync limit)
- [ ] Progress events are emitted for UI feedback
- [ ] Tests cover the happy path and error cases
- [ ] Package registered in `ConnectorsService`
