# API Reference

The Botmem REST API is served by a NestJS application on port 3001 (configurable via the `PORT` environment variable). All endpoints are prefixed with `/api`.

**Base URL:** `http://localhost:3001/api`

## Authentication

The API does not currently require authentication. It is designed for single-user, local deployment. All endpoints are accessible without tokens or API keys.

## Response Format

All endpoints return JSON. Error responses follow this format:

```json
{
  "error": "Description of the error"
}
```

Successful responses vary by endpoint -- see the individual reference pages.

## Endpoints Overview

### Memories

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/memories/search` | Semantic search across memories |
| `GET` | `/api/memories` | List memories with pagination |
| `GET` | `/api/memories/stats` | Get memory statistics |
| `GET` | `/api/memories/graph` | Get the relationship graph |
| `GET` | `/api/memories/:id` | Get a single memory |
| `POST` | `/api/memories` | Create a manual memory |
| `DELETE` | `/api/memories/:id` | Delete a memory |
| `POST` | `/api/memories/retry-failed` | Retry failed embeddings |
| `POST` | `/api/memories/backfill-contacts` | Backfill contact links |

[Full reference](/api/memories)

### Contacts

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/contacts` | List contacts |
| `GET` | `/api/contacts/suggestions` | Get merge suggestions |
| `GET` | `/api/contacts/:id` | Get a contact |
| `GET` | `/api/contacts/:id/memories` | Get memories for a contact |
| `PATCH` | `/api/contacts/:id` | Update a contact |
| `DELETE` | `/api/contacts/:id` | Delete a contact |
| `POST` | `/api/contacts/search` | Search contacts |
| `POST` | `/api/contacts/:id/merge` | Merge two contacts |
| `POST` | `/api/contacts/normalize` | Normalize all contacts |
| `POST` | `/api/contacts/suggestions/dismiss` | Dismiss a merge suggestion |

[Full reference](/api/contacts)

### Connectors

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/connectors` | List all registered connectors |
| `GET` | `/api/connectors/:type/schema` | Get config schema for a connector |
| `GET` | `/api/connectors/:type/status` | Get connector status |

[Full reference](/api/connectors)

### Accounts

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/accounts` | List all accounts |
| `GET` | `/api/accounts/:id` | Get a single account |
| `POST` | `/api/accounts` | Create an account |
| `PATCH` | `/api/accounts/:id` | Update an account |
| `DELETE` | `/api/accounts/:id` | Delete an account |

### Auth

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/auth/:type/has-credentials` | Check if credentials exist |
| `POST` | `/api/auth/:type/initiate` | Start auth flow |
| `GET` | `/api/auth/:type/callback` | OAuth callback handler |
| `POST` | `/api/auth/:type/complete` | Complete auth flow |

### Jobs

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/jobs` | List all jobs |
| `GET` | `/api/jobs/queues` | Get queue statistics |
| `GET` | `/api/jobs/:id` | Get a single job |
| `POST` | `/api/jobs/sync/:accountId` | Trigger a sync |
| `DELETE` | `/api/jobs/:id` | Cancel a job |

[Full reference](/api/jobs)

### Settings

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/settings` | Get all settings |
| `PATCH` | `/api/settings` | Update settings |

### Logs

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/logs` | Query logs |

### WebSocket

| Path | Description |
|---|---|
| `ws://localhost:3001/events` | Real-time event gateway |

[Full reference](/api/websocket)

### Version

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/version` | Get server version |
