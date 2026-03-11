# API Reference

The Botmem REST API is served by a NestJS application on port 12412 (configurable via the `PORT` environment variable). All endpoints are prefixed with `/api`.

**Base URL:** `http://localhost:12412/api`

::: tip Interactive API Explorer
The full OpenAPI spec is auto-generated from source code. Try the [Swagger UI](/api/docs) for interactive exploration, or see the [OpenAPI Schema](/api/openapi) page for type generation.
:::

## Authentication

All API endpoints require authentication (except `GET /api/version`). Include a Bearer token in the `Authorization` header:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:12412/api/memories
```

Tokens can be:

- **Access tokens** — obtained from `POST /api/user-auth/login` (15-minute lifetime)
- **API keys** — created via `POST /api/api-keys` (no expiry, format: `bm_sk_...`)

See [Authentication](/guide/authentication) for full details on signup, login, token refresh, and recovery keys.

## Response Format

All endpoints return JSON. Error responses follow this format:

```json
{
  "error": "Description of the error"
}
```

Successful responses vary by endpoint — see the individual reference pages.

## Endpoints Overview

### User Auth

| Method  | Path                          | Description                        |
| ------- | ----------------------------- | ---------------------------------- |
| `POST`  | `/api/user-auth/register`     | Create a new account               |
| `POST`  | `/api/user-auth/login`        | Login with email/password          |
| `POST`  | `/api/user-auth/refresh`      | Refresh access token (uses cookie) |
| `POST`  | `/api/user-auth/recovery-key` | Submit recovery key for decryption |
| `POST`  | `/api/user-auth/logout`       | Logout (clears refresh cookie)     |
| `GET`   | `/api/me`                     | Get current user profile           |
| `PATCH` | `/api/me`                     | Update user profile                |

### API Keys

| Method   | Path                | Description       |
| -------- | ------------------- | ----------------- |
| `GET`    | `/api/api-keys`     | List API keys     |
| `POST`   | `/api/api-keys`     | Create an API key |
| `DELETE` | `/api/api-keys/:id` | Revoke an API key |

### Memories

| Method   | Path                              | Description                     |
| -------- | --------------------------------- | ------------------------------- |
| `POST`   | `/api/memories/search`            | Semantic search across memories |
| `GET`    | `/api/memories`                   | List memories with pagination   |
| `GET`    | `/api/memories/stats`             | Get memory statistics           |
| `GET`    | `/api/memories/graph`             | Get the relationship graph      |
| `GET`    | `/api/memories/:id`               | Get a single memory             |
| `POST`   | `/api/memories`                   | Create a manual memory          |
| `DELETE` | `/api/memories/:id`               | Delete a memory                 |
| `POST`   | `/api/memories/retry-failed`      | Retry failed embeddings         |
| `POST`   | `/api/memories/backfill-contacts` | Backfill contact links          |

[Full reference](/api/memories)

### Contacts

| Method   | Path                                | Description                |
| -------- | ----------------------------------- | -------------------------- |
| `GET`    | `/api/contacts`                     | List contacts              |
| `GET`    | `/api/contacts/suggestions`         | Get merge suggestions      |
| `GET`    | `/api/contacts/:id`                 | Get a contact              |
| `GET`    | `/api/contacts/:id/memories`        | Get memories for a contact |
| `PATCH`  | `/api/contacts/:id`                 | Update a contact           |
| `DELETE` | `/api/contacts/:id`                 | Delete a contact           |
| `POST`   | `/api/contacts/search`              | Search contacts            |
| `POST`   | `/api/contacts/:id/merge`           | Merge two contacts         |
| `POST`   | `/api/contacts/normalize`           | Normalize all contacts     |
| `POST`   | `/api/contacts/suggestions/dismiss` | Dismiss a merge suggestion |

[Full reference](/api/contacts)

### Connectors

| Method | Path                           | Description                       |
| ------ | ------------------------------ | --------------------------------- |
| `GET`  | `/api/connectors`              | List all registered connectors    |
| `GET`  | `/api/connectors/:type/schema` | Get config schema for a connector |
| `GET`  | `/api/connectors/:type/status` | Get connector status              |

[Full reference](/api/connectors)

### Accounts

| Method   | Path                | Description          |
| -------- | ------------------- | -------------------- |
| `GET`    | `/api/accounts`     | List all accounts    |
| `GET`    | `/api/accounts/:id` | Get a single account |
| `POST`   | `/api/accounts`     | Create an account    |
| `PATCH`  | `/api/accounts/:id` | Update an account    |
| `DELETE` | `/api/accounts/:id` | Delete an account    |

### Auth (Connector OAuth)

| Method | Path                              | Description                |
| ------ | --------------------------------- | -------------------------- |
| `GET`  | `/api/auth/:type/has-credentials` | Check if credentials exist |
| `POST` | `/api/auth/:type/initiate`        | Start auth flow            |
| `GET`  | `/api/auth/:type/callback`        | OAuth callback handler     |
| `POST` | `/api/auth/:type/complete`        | Complete auth flow         |

### Jobs

| Method   | Path                        | Description          |
| -------- | --------------------------- | -------------------- |
| `GET`    | `/api/jobs`                 | List all jobs        |
| `GET`    | `/api/jobs/queues`          | Get queue statistics |
| `GET`    | `/api/jobs/:id`             | Get a single job     |
| `POST`   | `/api/jobs/sync/:accountId` | Trigger a sync       |
| `DELETE` | `/api/jobs/:id`             | Cancel a job         |

[Full reference](/api/jobs)

### Agent API

| Method | Path                  | Description                    |
| ------ | --------------------- | ------------------------------ |
| `POST` | `/api/agent/ask`      | Ask a question (AI-powered)    |
| `POST` | `/api/agent/timeline` | Build a timeline for a topic   |
| `POST` | `/api/agent/context`  | Get context for a conversation |
| `POST` | `/api/agent/remember` | Store a new memory             |
| `GET`  | `/api/agent/entities` | List extracted entities        |

### Memory Banks

| Method   | Path                    | Description          |
| -------- | ----------------------- | -------------------- |
| `GET`    | `/api/memory-banks`     | List memory banks    |
| `POST`   | `/api/memory-banks`     | Create a memory bank |
| `PATCH`  | `/api/memory-banks/:id` | Update a memory bank |
| `DELETE` | `/api/memory-banks/:id` | Delete a memory bank |

### Billing (Managed tier only)

| Method | Path                    | Description                        |
| ------ | ----------------------- | ---------------------------------- |
| `GET`  | `/api/billing/status`   | Get subscription status            |
| `POST` | `/api/billing/checkout` | Create Stripe checkout session     |
| `POST` | `/api/billing/portal`   | Create Stripe customer portal link |

### Settings

| Method  | Path            | Description      |
| ------- | --------------- | ---------------- |
| `GET`   | `/api/settings` | Get all settings |
| `PATCH` | `/api/settings` | Update settings  |

### Logs

| Method | Path        | Description |
| ------ | ----------- | ----------- |
| `GET`  | `/api/logs` | Query logs  |

### WebSocket

| Path                          | Description             |
| ----------------------------- | ----------------------- |
| `ws://localhost:12412/events` | Real-time event gateway |

[Full reference](/api/websocket)

### Version

| Method | Path           | Description                           |
| ------ | -------------- | ------------------------------------- |
| `GET`  | `/api/version` | Get server version (no auth required) |
