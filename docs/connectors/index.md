# Connectors

Connectors are pluggable data source adapters that pull data from external services into Botmem's memory store. Each connector extends the `BaseConnector` class from `@botmem/connector-sdk` and implements a standard interface for authentication and data synchronization.

## Available Connectors

| Connector                                      | Auth Type  | What It Syncs                               |
| ---------------------------------------------- | ---------- | ------------------------------------------- |
| [Gmail / Google](/connectors/gmail)            | OAuth 2.0  | Emails, contacts, attachments               |
| [Outlook](/connectors/outlook)                 | OAuth 2.0  | Emails, contacts                            |
| [Slack](/connectors/slack)                     | API Token  | Channel messages, DMs, user profiles, files |
| [WhatsApp](/connectors/whatsapp)               | QR Code    | Chat messages, group chats                  |
| [Telegram](/connectors/telegram)               | Phone Code | Chat messages, group chats                  |
| [iMessage](/connectors/imessage)               | Local Tool | iMessage chat history (macOS only)          |
| [Photos / Immich](/connectors/immich)          | API Key    | Photos, albums, facial recognition tags     |
| [Locations / OwnTracks](/connectors/owntracks) | API Key    | GPS location history                        |

## How Connectors Work

Every connector follows the same lifecycle:

### 1. Registration

Connectors are registered via the plugin system at startup. Each connector provides a manifest describing its ID, name, auth type, configuration schema, entity types, trust score, and pipeline configuration. Built-in connectors are loaded via `loadBuiltin()` in `plugins.service.ts`.

### 2. Authentication

Depending on the auth type:

- **OAuth 2.0** -- User is redirected to the service's consent screen, then back to Botmem with an authorization code which is exchanged for access/refresh tokens
- **QR Code** -- A QR code is displayed in the web UI for the user to scan with their mobile app
- **Phone Code** -- A verification code is sent to the user's phone number
- **API Key** -- User provides credentials directly in the configuration form
- **Local Tool** -- No authentication needed; the connector reads from a local resource

### 3. Sync

When a sync is triggered (manually or on a schedule), the connector's `sync()` method is called with a `SyncContext` containing the account credentials, a cursor for incremental sync, and a logger. The connector emits `ConnectorDataEvent` objects for each piece of data it finds.

### 4. Processing

Each emitted event flows through the pipeline:

1. **Sync queue** -- raw event is saved to the database
2. **Embed queue** -- memory record created, embedding generated, contacts resolved
3. **File queue** -- (for file/photo events) content extracted and re-embedded
4. **Enrich queue** -- entities extracted, factuality classified, graph links created

Connectors can customize pipeline behavior by overriding `clean()`, `embed()`, and `enrich()` methods.

## Data Types

Connectors emit events with one of these source types:

| Source Type | Description                                             | Connectors                          |
| ----------- | ------------------------------------------------------- | ----------------------------------- |
| `email`     | Email messages with headers, body, and recipients       | Gmail, Outlook                      |
| `message`   | Chat messages with sender and channel                   | Slack, WhatsApp, Telegram, iMessage |
| `contact`   | People/contacts with metadata (name, email, phone, org) | Gmail, Outlook, Slack               |
| `photo`     | Photos with EXIF data, descriptions, and face tags      | Photos/Immich                       |
| `location`  | GPS coordinates with timestamps                         | OwnTracks                           |
| `file`      | Documents, spreadsheets, PDFs, images from services     | Gmail (attachments), Slack (files)  |

## Trust Scores

Each connector has a base trust score that influences the final ranking of memories:

| Connector             | Trust Score | Rationale                                 |
| --------------------- | ----------- | ----------------------------------------- |
| Gmail                 | 0.95        | Official email with verified sender       |
| Outlook               | 0.90        | Enterprise email with verified sender     |
| Slack                 | 0.90        | Workspace-authenticated messages          |
| Telegram              | 0.85        | Phone-verified accounts                   |
| Photos / Immich       | 0.85        | EXIF-verified timestamps and locations    |
| Locations / OwnTracks | 0.85        | GPS sensor data                           |
| WhatsApp              | 0.80        | End-to-end encrypted but metadata limited |
| iMessage              | 0.80        | Local database, no server verification    |
| Manual                | 0.70        | User-entered data, no source verification |

## Default Sync Behavior

Botmem's default behavior is to pull the **maximum data available** from any connector -- full history, not just recent items. This ensures complete coverage of your personal memory. Incremental sync (using cursors) is used for subsequent syncs to only pull new data.

## Adding a New Connector

See [Building a Connector](/connectors/building-a-connector) for a complete guide to creating a custom connector, including examples for both API-key and OAuth2 auth flows.
