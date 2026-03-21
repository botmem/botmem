# Connector SDK Reference

The `@botmem/connector-sdk` package provides the `BaseConnector` abstract class and all the types needed to build a Botmem connector.

## Installation

Connectors in the monorepo use workspace linking:

```json
{
  "dependencies": {
    "@botmem/connector-sdk": "workspace:*"
  }
}
```

## BaseConnector

The abstract class that all connectors must extend.

```typescript
import { EventEmitter } from 'events';

abstract class BaseConnector extends EventEmitter {
  // Debug limit (0 = disabled). Set > 0 to stop sync after N emits.
  static DEBUG_SYNC_LIMIT: number;

  // The connector's manifest (metadata, auth type, config schema)
  abstract readonly manifest: ConnectorManifest;

  // Authentication lifecycle
  abstract initiateAuth(config: Record<string, unknown>): Promise<AuthInitResult>;
  abstract completeAuth(params: Record<string, unknown>): Promise<AuthContext>;
  abstract validateAuth(auth: AuthContext): Promise<boolean>;
  abstract revokeAuth(auth: AuthContext): Promise<void>;

  // Data sync
  abstract sync(ctx: SyncContext): Promise<SyncResult>;

  // ── Pipeline override methods ──────────────────────────
  // Override these to customize how your connector's data is processed.

  // Strip HTML, normalize text, remove tracking URLs
  clean(event: ConnectorDataEvent, ctx: PipelineContext): CleanResult | Promise<CleanResult>;

  // Prepare embedding data: return text + person entities for search indexing
  embed(
    event: ConnectorDataEvent,
    cleanedText: string,
    ctx: PipelineContext,
  ): EmbedResult | Promise<EmbedResult>;

  // Extract claims, classify factuality, add entities (default: no-op)
  enrich(memoryId: string, ctx: PipelineContext): EnrichResult | Promise<EnrichResult>;

  // Extract content from files/attachments (default: null)
  extractFile(fileUrl: string, mimeType: string, auth: AuthContext): Promise<string | null>;

  // ── Emit helpers ───────────────────────────────────────

  // Emit a data event (use this instead of this.emit('data', event))
  emitData(event: ConnectorDataEvent): boolean;

  // Check if event should be emitted (noise filtering)
  shouldEmit(event: ConnectorDataEvent): boolean;

  // Emit a progress update
  emitProgress(event: ProgressEvent): boolean;

  // Log a message (emits a 'log' event)
  protected log(level: LogEvent['level'], message: string): void;

  // Check if the debug sync limit has been reached
  get isLimitReached(): boolean;

  // Number of events filtered as noise during this sync
  get filteredCount(): number;

  // Reset the emit counter (called between syncs)
  resetSyncLimit(): void;

  // Wrap a SyncContext with a limit-aware abort signal
  wrapSyncContext(ctx: SyncContext): SyncContext;
}
```

### emitData(event)

Use `emitData()` instead of `this.emit('data', event)`. It:

1. Applies noise filtering via `shouldEmit()` — OTP codes, automated senders, marketing emails are skipped
2. Respects `DEBUG_SYNC_LIMIT` -- returns `false` after the limit is reached
3. Aborts the sync signal when the limit is hit
4. Tracks the emit count

Always check the return value:

```typescript
if (!this.emitData(event)) {
  break; // Limit reached or noise filtered, stop emitting
}
```

::: warning
`emitData()` returns `false` both when the debug limit is reached AND when there are no registered `data` event listeners. In tests, always add a `connector.on('data', ...)` listener before calling `sync()`.
:::

### emitProgress(event)

Emit progress updates for the UI:

```typescript
this.emitProgress({
  processed: 150,
  total: 8500,
});
```

### log(level, message)

Emit structured log messages:

```typescript
this.log('info', 'Starting sync...');
this.log('warn', 'Rate limited, retrying');
this.log('error', 'API returned 500');
this.log('debug', 'Fetched page 3 of 10');
```

### Pipeline Override Methods

Override these to customize how your connector's data flows through the processing pipeline. All have sensible defaults.

#### `clean(event, ctx): CleanResult`

Strips HTML tags, removes tracking URLs, collapses whitespace. Override to handle service-specific cruft (e.g., Outlook SafeLinks, Gmail tracking pixels).

```typescript
clean(event: ConnectorDataEvent, ctx: PipelineContext): CleanResult {
  let { text } = super.clean(event, ctx) as CleanResult;
  // Strip Outlook SafeLinks
  text = text.replace(/https:\/\/\S*safelinks\.protection\.outlook\.com\S*/gi, '');
  return { text };
}
```

#### `embed(event, cleanedText, ctx): EmbedResult`

Prepares text and entities for search indexing. Default extracts participants as person entities. Override to add structured entities from email headers, contact records, etc.

```typescript
embed(event: ConnectorDataEvent, cleanedText: string, ctx: PipelineContext): EmbedResult {
  const base = super.embed(event, cleanedText, ctx) as EmbedResult;
  // Add sender/recipient roles from email headers
  const from = event.content.metadata.from as string;
  if (from) {
    base.entities.push({ type: 'person', id: from, role: 'sender' });
  }
  return base;
}
```

#### `enrich(memoryId, ctx): EnrichResult`

Extracts entities, claims, and factuality after memory creation. Default is a no-op — the global enrichment pipeline handles most cases. Override for connector-specific enrichment.

#### `extractFile(fileUrl, mimeType, auth): Promise<string | null>`

Extracts text content from files and attachments. Default returns `null`. Override to handle service-specific file downloads (e.g., Gmail attachment API, Slack file download).

## Types

### ConnectorManifest

```typescript
type AuthType = 'oauth2' | 'qr-code' | 'phone-code' | 'api-key' | 'local-tool';

interface ConnectorManifest {
  id: string; // Unique connector identifier (e.g., 'gmail', 'slack')
  name: string; // Display name (e.g., 'Google', 'Slack')
  description: string; // Short description
  color: string; // Brand color hex (e.g., '#FF6B9D')
  icon: string; // Icon name for the UI
  authType: AuthType; // Authentication method
  configSchema: Record<string, unknown>; // JSON Schema for config form

  // Entity types this connector produces (e.g., ['email', 'contact'])
  entities: string[];

  // Pipeline stages this connector uses. Omitted stages default to true.
  pipeline: {
    clean?: boolean;
    embed?: boolean;
    enrich?: boolean;
  };

  // Base trust score for memories from this connector (0-1)
  trustScore: number;

  // Weight coefficients for scoring formula overrides
  weights?: {
    semantic?: number; // default: 0.40
    recency?: number; // default: 0.25
    importance?: number; // default: 0.20
    trust?: number; // default: 0.15
  };
}
```

### AuthContext

Stored credentials returned from `completeAuth()`:

```typescript
interface AuthContext {
  accessToken?: string; // API token or OAuth access token
  refreshToken?: string; // OAuth refresh token
  expiresAt?: string; // Token expiration (ISO 8601)
  identifier?: string; // User identifier (email, username)
  raw?: Record<string, unknown>; // Additional connector-specific data
}
```

#### `auth.raw` Convention for OAuth2

For OAuth2 connectors, store the OAuth client configuration in `auth.raw` during `completeAuth()` so that `sync()` can reconstruct the OAuth client for token refresh:

```typescript
// In completeAuth():
return {
  accessToken: tokens.access_token,
  refreshToken: tokens.refresh_token,
  expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  identifier: profile.email,
  raw: {
    clientId,
    clientSecret,
    tenantId, // Service-specific fields
    redirectUri,
  },
};
```

### AuthInitResult

The result of `initiateAuth()`. One of four types:

```typescript
type AuthInitResult =
  | { type: 'redirect'; url: string } // OAuth: redirect to consent screen
  | { type: 'qr-code'; qrData: string; wsChannel: string } // QR: show code
  | { type: 'phone-code'; phoneCodeHash: string; wsChannel: string } // Phone: send code
  | { type: 'complete'; auth: AuthContext }; // Immediate: credentials accepted
```

### SyncContext

Passed to `sync()` with everything the connector needs:

```typescript
interface SyncContext {
  accountId: string; // The account ID in Botmem
  auth: AuthContext; // Stored credentials
  cursor: string | null; // Cursor from previous sync (null on first sync)
  jobId: string; // Current job ID for logging
  logger: ConnectorLogger; // Structured logger
  signal: AbortSignal; // Cancellation signal
}
```

### SyncResult

Returned from `sync()`:

```typescript
interface SyncResult {
  cursor: string | null; // Cursor to resume from next time
  hasMore: boolean; // Whether more data is available
  processed: number; // Number of events emitted
}
```

### ConnectorDataEvent

The normalized data format emitted during sync:

```typescript
interface ConnectorDataEvent {
  sourceType: 'email' | 'message' | 'contact' | 'photo' | 'location' | 'file';
  sourceId: string; // Unique ID from the external service
  timestamp: string; // When the event occurred (ISO 8601)
  content: {
    text?: string; // Text content for embedding and search
    participants?: string[]; // People involved (for contact resolution)
    attachments?: Array<{
      uri: string; // URL or path to the attachment
      mimeType: string; // MIME type
      filename?: string; // Original filename
      size?: number; // File size in bytes
    }>;
    metadata: Record<string, unknown>; // Connector-specific data
  };
}
```

### OAuth2CompleteParams

Typed shape of `params` passed to `completeAuth()` for OAuth2 connectors:

```typescript
interface OAuth2CompleteParams {
  code: string; // Authorization code from redirect
  state?: string; // CSRF state parameter
  clientId?: string; // Original client ID (echoed back)
  clientSecret?: string; // Original client secret (echoed back)
  redirectUri?: string; // Original redirect URI (echoed back)
  [key: string]: unknown;
}
```

::: info
For `api-key` auth, `params` is the `AuthContext` returned from `initiateAuth()`.
For `qr-code` auth, `params` contains the session data from the WebSocket channel.
For `phone-code` auth, `params` contains `{ code: string; phoneCodeHash: string }`.
:::

### ContactEventMetadata

Typed metadata convention for contact-type events:

```typescript
interface ContactEventMetadata {
  type: 'contact';
  name?: string;
  givenName?: string;
  familyName?: string;
  emails?: string[];
  phones?: string[];
  organizations?: Array<{ name?: string; title?: string }>;
  nicknames?: string[];
  addresses?: unknown[];
  birthday?: string;
  bio?: string;
  imClients?: string[];
  photos?: string[];
}
```

Usage:

```typescript
const event: ConnectorDataEvent = {
  sourceType: 'contact',
  sourceId: `contact-${contact.id}`,
  timestamp: new Date().toISOString(),
  content: {
    text: [contact.name, ...contact.emails].join(' '),
    participants: [contact.name, ...contact.emails],
    metadata: {
      type: 'contact',
      name: contact.name,
      givenName: contact.givenName,
      familyName: contact.familyName,
      emails: contact.emails,
      phones: contact.phones,
      organizations: contact.organizations,
    } satisfies ContactEventMetadata,
  },
};
```

### Pipeline Types

These types are exported from the SDK for use in pipeline override methods:

```typescript
interface CleanResult {
  text: string;
  metadata?: Record<string, unknown>;
}

interface EmbedResult {
  text: string;
  entities: Array<{ type: string; id: string; role: string }>;
  metadata?: Record<string, unknown>;
}

interface EnrichResult {
  entities?: Array<{ type: string; value: string }>;
  claims?: string[];
  factuality?: { label: string; confidence: number; rationale: string };
  metadata?: Record<string, unknown>;
}

interface PipelineContext {
  accountId: string;
  auth: AuthContext;
  logger: ConnectorLogger;
}
```

### ConnectorLogger

Structured logging interface:

```typescript
interface ConnectorLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}
```

### ProgressEvent

Progress update for the UI:

```typescript
interface ProgressEvent {
  processed: number; // Number of items processed so far
  total?: number; // Total items (if known)
}
```

### LogEvent

Internal log event structure:

```typescript
interface LogEvent {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
}
```

## Events

`BaseConnector` extends `EventEmitter` and emits these events:

| Event      | Payload              | Description                    |
| ---------- | -------------------- | ------------------------------ |
| `data`     | `ConnectorDataEvent` | A new data event to ingest     |
| `progress` | `ProgressEvent`      | Sync progress update           |
| `log`      | `LogEvent`           | Log message from the connector |

## Debug Sync Limit

The static property `BaseConnector.DEBUG_SYNC_LIMIT` controls how many events a connector can emit before the sync is aborted. This is useful during development to test with small data sets.

```typescript
// Limit to 10 events (for testing)
BaseConnector.DEBUG_SYNC_LIMIT = 10;

// Disable limit (production default)
BaseConnector.DEBUG_SYNC_LIMIT = 0;
```

::: warning
When `DEBUG_SYNC_LIMIT > 0`, the abort signal is triggered after N emits. This kills any subsequent sync phases (e.g., contacts sync after email sync). Always set to 0 in production.
:::

## Default Export

Connectors **must** export a factory function as the default export:

```typescript
export default () => new MyConnector();
```

This factory is called by the plugin system to create instances. Do **not** export a singleton instance — each call must return a fresh instance.

## Noise Filtering

The SDK includes built-in noise filtering via `shouldEmit()`. Events matching these patterns are automatically skipped:

- **OTP codes** — 6-digit codes, alphanumeric verification tokens
- **Automated senders** — no-reply, noreply, donotreply addresses
- **Notification SMS** — carrier alerts, app transactional messages
- **Marketing emails** — messages with unsubscribe headers or promotional patterns

Contact-type events (`metadata.type === 'contact'`) are never filtered.

To use noise filtering in your connector, just call `emitData()` — it applies `shouldEmit()` automatically. You can also call `shouldEmit(event)` directly if you need to check before processing.
