# Authentication

Botmem supports two authentication providers: **local** (JWT-based, default) and **Firebase**. All API endpoints require authentication except `GET /api/version`.

## Auth Providers

### Local (default)

Uses email/password registration with JWT tokens. Set `AUTH_PROVIDER=local` (or leave unset).

### Firebase

Uses Firebase Authentication for login (email/password, Google sign-in, etc.). Set `AUTH_PROVIDER=firebase` and configure `FIREBASE_PROJECT_ID` and `FIREBASE_SERVICE_ACCOUNT`.

## User Registration

### Sign Up

```bash
curl -X POST http://localhost:12412/api/user-auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"your-password","name":"Your Name"}'
```

**Response:**

```json
{
  "accessToken": "eyJhbG...",
  "recoveryKey": "oasULlqbDL6lmHuAZWplONBY9QykEp7KdhQP9lZsX/c="
}
```

::: danger Save your recovery key
The **recovery key** is shown only once at signup. It is a random 32-byte key (base64-encoded) used to encrypt your data at rest. If you lose it, your encrypted connector credentials cannot be recovered.
:::

A refresh token is set as an HTTP-only cookie automatically.

### Login

```bash
curl -X POST http://localhost:12412/api/user-auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"your-password"}'
```

**Response:**

```json
{
  "accessToken": "eyJhbG..."
}
```

## Token Lifecycle

| Token         | Lifetime                                              | Storage                      |
| ------------- | ----------------------------------------------------- | ---------------------------- |
| Access token  | 15 minutes (configurable via `JWT_ACCESS_EXPIRES_IN`) | Client-side (memory, header) |
| Refresh token | 7 days (configurable via `JWT_REFRESH_EXPIRES_IN`)    | HTTP-only cookie             |

### Refreshing Tokens

```bash
curl -X POST http://localhost:12412/api/user-auth/refresh \
  --cookie "refreshToken=..."
```

Returns a new `accessToken`. The refresh cookie is rotated automatically.

### Using Tokens

Add the access token to every request as a Bearer token:

```bash
curl -H "Authorization: Bearer eyJhbG..." \
  http://localhost:12412/api/memories
```

## Recovery Key

The recovery key is fundamental to Botmem's encryption model:

1. **Generated at signup** — random 32 bytes, shown once as base64
2. **SHA-256 hash stored** — the server stores only the hash for verification, never the key itself
3. **Cached for convenience** — the key is cached in memory and Redis (encrypted with `APP_SECRET`, 30-day TTL)
4. **Used for decryption** — connector credentials are encrypted at rest with this key

### When the Cache Is Cold

If the server restarts and Redis cache has expired, the API will respond with `needsRecoveryKey: true`. Submit your recovery key to re-establish the session:

```bash
curl -X POST http://localhost:12412/api/user-auth/recovery-key \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"recoveryKey":"oasULlqbDL6lmHuAZWplONBY9QykEp7KdhQP9lZsX/c="}'
```

## API Keys (for Agents)

For programmatic access (CLI, AI agents, scripts), create an API key:

```bash
curl -X POST http://localhost:12412/api/api-keys \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"My Agent"}'
```

**Response:**

```json
{
  "id": "key-uuid",
  "key": "bm_sk_abc123...",
  "name": "My Agent"
}
```

Use the API key as a Bearer token:

```bash
curl -H "Authorization: Bearer bm_sk_abc123..." \
  http://localhost:12412/api/memories
```

API keys do not expire and can be revoked via `DELETE /api/api-keys/:id`.

## CLI Authentication

The `botmem` CLI stores credentials locally:

```bash
# Login with email/password
botmem login

# Login with API key
botmem login --api-key bm_sk_abc123...

# Check auth status
botmem version
```

See the [CLI Reference](/agent-api/cli) for more details.

## User Auth Endpoints

| Method  | Path                          | Description                    |
| ------- | ----------------------------- | ------------------------------ |
| `POST`  | `/api/user-auth/register`     | Create a new account           |
| `POST`  | `/api/user-auth/login`        | Login with email/password      |
| `POST`  | `/api/user-auth/refresh`      | Refresh access token           |
| `POST`  | `/api/user-auth/recovery-key` | Submit recovery key            |
| `POST`  | `/api/user-auth/logout`       | Logout (clears refresh cookie) |
| `GET`   | `/api/me`                     | Get current user profile       |
| `PATCH` | `/api/me`                     | Update user profile            |
