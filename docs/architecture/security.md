# Security & Encryption

Botmem encrypts sensitive data at rest and uses JWT tokens for API authentication. This page documents the security architecture.

## Credential Encryption

Connector credentials (OAuth tokens, API keys) are encrypted at rest using **AES-256-GCM**.

### How It Works

1. **Signup** — a random 32-byte recovery key is generated and shown to the user once (base64-encoded)
2. **Storage** — only the SHA-256 hash of the recovery key is stored in the database (`users.recovery_key_hash`)
3. **Caching** — the recovery key is cached in memory and in Redis (encrypted with `APP_SECRET`, 30-day TTL) for convenience
4. **Encryption** — when storing connector credentials, the recovery key is used as the AES-256-GCM encryption key
5. **Decryption** — when reading credentials, the cached recovery key decrypts them

### Recovery Key Flow

```
User signs up
  → Server generates 32-byte random key
  → SHA-256(key) stored in users table
  → Key cached in memory + Redis (encrypted)
  → Key returned to user (shown once)

User connects a service (e.g., Gmail OAuth)
  → OAuth tokens encrypted with recovery key
  → Encrypted blob stored in accounts table

Server restart (cache cold)
  → User submits recovery key via POST /api/user-auth/recovery-key
  → Server verifies SHA-256 hash matches
  → Key re-cached in memory + Redis
  → Credentials can be decrypted again
```

### Why Not Password-Based Encryption?

Previous versions derived the encryption key from the user's password. This meant password changes or resets would invalidate all encrypted data. The recovery key is independent of the password — you can change your password without affecting encryption.

## JWT Authentication

### Token Types

| Token                 | Purpose                  | Lifetime   | Storage                                |
| --------------------- | ------------------------ | ---------- | -------------------------------------- |
| Access token          | API authentication       | 15 minutes | Client memory / `Authorization` header |
| Refresh token         | Obtain new access tokens | 7 days     | HTTP-only cookie                       |
| API key (`bm_sk_...`) | Programmatic access      | No expiry  | Client-managed                         |

### Token Flow

```
Login → access token (15m) + refresh cookie (7d)
  → Access token in Authorization: Bearer header
  → When expired: POST /user-auth/refresh with cookie
  → New access token returned
```

### Secrets

Four secrets are used for different purposes:

| Variable             | Purpose                                 |
| -------------------- | --------------------------------------- |
| `APP_SECRET`         | Encrypting recovery keys in Redis cache |
| `JWT_ACCESS_SECRET`  | Signing access tokens                   |
| `JWT_REFRESH_SECRET` | Signing refresh tokens                  |
| `OAUTH_JWT_SECRET`   | Signing OAuth state parameters          |

All must be changed from their default values in production. The server validates this on startup.

## CORS

CORS is configured via the `FRONTEND_URL` environment variable. Only the specified origin is allowed to make cross-origin requests. In development, this defaults to `http://localhost:12412`.

## Production Security Checklist

- [ ] All four secrets changed from defaults (`APP_SECRET`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `OAUTH_JWT_SECRET`)
- [ ] `NODE_ENV=production` set
- [ ] HTTPS enabled (via Caddy or another reverse proxy)
- [ ] `FRONTEND_URL` set to your production domain
- [ ] PostgreSQL password is strong and not the default
- [ ] Redis is not exposed to the public internet
- [ ] Qdrant is not exposed to the public internet
- [ ] Backups configured for PostgreSQL and Redis
