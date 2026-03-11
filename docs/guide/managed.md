# Self-Hosted vs Managed

Botmem is available in two modes: **self-hosted** (free, open-source) and **managed Pro** ($14.99/mo at botmem.xyz).

## Comparison

| Feature        | Self-Hosted                      | Managed Pro                          |
| -------------- | -------------------------------- | ------------------------------------ |
| **Price**      | Free                             | $14.99/month                         |
| **Code**       | Same open-source codebase        | Same open-source codebase            |
| **API**        | Same REST + WebSocket API        | Same REST + WebSocket API            |
| **CLI**        | Same `botmem` CLI                | Same `botmem` CLI                    |
| **Encryption** | AES-256-GCM with recovery key    | AES-256-GCM with recovery key        |
| **Hosting**    | Your hardware                    | Managed infrastructure at botmem.xyz |
| **AI Backend** | You provide Ollama or OpenRouter | Preconfigured cloud AI               |
| **Database**   | You manage PostgreSQL            | Managed PostgreSQL                   |
| **Updates**    | Manual (`git pull`)              | Automatic                            |
| **Billing**    | None                             | Stripe integration                   |

## How It Works

Both modes run the exact same codebase. The difference is determined by the `STRIPE_SECRET_KEY` environment variable:

- **Self-hosted mode** — `STRIPE_SECRET_KEY` is empty (default). No billing features, no Stripe integration.
- **Managed mode** — `STRIPE_SECRET_KEY` is set. Enables billing, subscription management, and usage tracking.

## End-to-End Encryption

Both modes use the same encryption model. Your recovery key never leaves your device — the server only stores a SHA-256 hash for verification. Connector credentials and sensitive data are encrypted at rest with AES-256-GCM using your recovery key.

This means **even on the managed tier, we cannot read your data**. If you lose your recovery key, your encrypted credentials cannot be recovered.

## Self-Hosted Setup

See the [Quick Start](/guide/quickstart) for local development and [Production Deployment](/guide/deployment) for running Botmem on your own server.

## Managed Pro

Sign up at [botmem.xyz](https://botmem.xyz) to get started. The managed tier includes:

- Fully managed PostgreSQL, Redis, and Qdrant infrastructure
- Preconfigured AI backend (no GPU or API keys needed)
- Automatic updates and backups
- Email support

Your data is encrypted with your personal recovery key — same security model as self-hosted.
