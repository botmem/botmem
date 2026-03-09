---
id: vault-key-e2ee
title: 'Phase 24.1 — Unified E2EE vault key (recovery passphrase model)'
area: security
priority: high
created: 2026-03-09
---

## What

Replace the current password-derived E2EE key (Phase 21) with a random vault key wrapped by a user-chosen Argon2id recovery passphrase, stored as an encrypted blob server-side.

## Why

- Current approach ties encryption to login password → password changes require re-encryption
- Firebase auth (Google/GitHub) has no password → E2EE is impossible with current design
- Recovery passphrase model works identically for local + Firebase auth users
- User can log in from any device/browser by entering their vault passphrase

## Design

```
First login (any auth method):
  → generate random 256-bit vault key
  → prompt: "Set a vault passphrase" (separate from login)
  → Argon2id(passphrase + random salt) → wrapping key
  → AES-GCM encrypt(vault key, wrapping key) → encrypted blob
  → POST /api/vault/setup { encryptedBlob, salt } → stored on users table

Subsequent logins (any device):
  → GET /api/vault/blob → { encryptedBlob, salt }
  → prompt: "Enter vault passphrase"
  → Argon2id(passphrase + salt) → wrapping key
  → AES-GCM decrypt(blob, wrapping key) → vault key
  → use vault key for all memory encryption/decryption
```

## Scope

- DB: `vaultKeyBlob` + `vaultKeySalt` columns on users table
- Backend: `POST /api/vault/setup`, `GET /api/vault/blob`, `DELETE /api/vault` (reset)
- Frontend: vault passphrase prompt at onboarding + login (replaces ReauthModal / needsRelogin flow)
- authStore: replace `encryptionKey` derivation from password with vault blob fetch + passphrase prompt
- Migration: existing local-auth users prompted once to set vault passphrase (current key is discarded)

## Notes

- If user forgets vault passphrase → data is unrecoverable (standard E2EE tradeoff, show warning)
- Vault passphrase ≠ login password → make this very clear in UI copy
- Phase 21 key derivation code can be reused for wrapping key generation
