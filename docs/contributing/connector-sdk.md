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

  // Emit a data event (use this instead of this.emit('data', event))
  emitData(event: ConnectorDataEvent): boolean;

  // Emit a progress update
  emitProgress(event: ProgressEvent): boolean;

  // Log a message (emits a 'log' event)
  protected log(level: LogEvent['level'], message: string): void;

  // Check if the debug sync limit has been reached
  get isLimitReached(): boolean;

  // Reset the emit counter (called between syncs)
  resetSyncLimit(): void;

  // Wrap a SyncContext with a limit-aware abort signal
  wrapSyncContext(ctx: SyncContext): SyncContext;
}
```

### emitData(event)

Use `emitData()` instead of `this.emit('data', event)`. It:
1. Respects `DEBUG_SYNC_LIMIT` -- returns `false` after the limit is reached
2. Aborts the sync signal when the limit is hit
3. Tracks the emit count

Always check the return value:

```typescript
if (!this.emitData(event)) {
  break;  // Limit reached, stop emitting
}
```

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

## Types

### ConnectorManifest

```typescript
type AuthType = 'oauth2' | 'qr-code' | 'api-key' | 'local-tool';

interface ConnectorManifest {
  id: string;         // Unique connector identifier (e.g., 'gmail', 'slack')
  name: string;       // Display name (e.g., 'Google', 'Slack')
  description: string; // Short description
  color: string;      // Brand color hex (e.g., '#FF6B9D')
  icon: string;       // Icon name for the UI
  authType: AuthType; // Authentication method
  configSchema: Record<string, unknown>; // JSON Schema for config form
}
```

### AuthContext

Stored credentials returned from `completeAuth()`:

```typescript
interface AuthContext {
  accessToken?: string;    // API token or OAuth access token
  refreshToken?: string;   // OAuth refresh token
  expiresAt?: string;      // Token expiration (ISO 8601)
  identifier?: string;     // User identifier (email, username)
  raw?: Record<string, unknown>; // Additional connector-specific data
}
```

### AuthInitResult

The result of `initiateAuth()`. One of three types:

```typescript
type AuthInitResult =
  | { type: 'redirect'; url: string }       // OAuth: redirect to consent screen
  | { type: 'qr-code'; qrData: string; wsChannel: string }  // QR: show code
  | { type: 'complete'; auth: AuthContext }; // Immediate: credentials accepted
```

### SyncContext

Passed to `sync()` with everything the connector needs:

```typescript
interface SyncContext {
  accountId: string;       // The account ID in Botmem
  auth: AuthContext;       // Stored credentials
  cursor: string | null;   // Cursor from previous sync (null on first sync)
  jobId: string;           // Current job ID for logging
  logger: ConnectorLogger; // Structured logger
  signal: AbortSignal;     // Cancellation signal
}
```

### SyncResult

Returned from `sync()`:

```typescript
interface SyncResult {
  cursor: string | null; // Cursor to resume from next time
  hasMore: boolean;      // Whether more data is available
  processed: number;     // Number of events emitted
}
```

### ConnectorDataEvent

The normalized data format emitted during sync:

```typescript
interface ConnectorDataEvent {
  sourceType: 'email' | 'message' | 'photo' | 'location' | 'file';
  sourceId: string;       // Unique ID from the external service
  timestamp: string;      // When the event occurred (ISO 8601)
  content: {
    text?: string;        // Text content for embedding and search
    participants?: string[]; // People involved (for contact resolution)
    attachments?: Array<{
      uri: string;        // URL or path to the attachment
      mimeType: string;   // MIME type
    }>;
    metadata: Record<string, unknown>; // Connector-specific data
  };
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
  processed: number;  // Number of items processed so far
  total?: number;     // Total items (if known)
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

| Event | Payload | Description |
|---|---|---|
| `data` | `ConnectorDataEvent` | A new data event to ingest |
| `progress` | `ProgressEvent` | Sync progress update |
| `log` | `LogEvent` | Log message from the connector |

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

Connectors must export a factory function as the default export:

```typescript
export default () => new MyConnector();
```

This factory is called by the connector registry to create instances.
