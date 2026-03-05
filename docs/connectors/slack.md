# Slack Connector

The Slack connector imports channel messages, direct messages, user profiles, and files from a Slack workspace.

**Auth type:** API Token (user token)
**Trust score:** 0.90
**Source types:** `message`, `file`

## What It Syncs

- **Channel messages** -- all messages from channels the user has access to, including threads
- **Direct messages** -- DMs and group DMs
- **User profiles** -- names, emails, phone numbers, titles, avatars for workspace members
- **Files** -- shared files are routed to the file processor for content extraction

## Setup

### 1. Get a Slack User Token

Botmem uses a Slack **user token** (`xoxp-...`) to access messages and files. You can obtain one by:

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Create a new app (or use an existing one) in your workspace
3. Navigate to **OAuth & Permissions**
4. Add the required scopes (see below)
5. Install the app to your workspace
6. Copy the **User OAuth Token** (`xoxp-...`)

### 2. Configure in Botmem

Navigate to the Connectors page and click **Add** on the Slack connector. Enter your user token.

## Required Scopes

| Scope | Purpose |
|---|---|
| `channels:history` | Read messages from public channels |
| `channels:read` | List public channels |
| `groups:history` | Read messages from private channels |
| `groups:read` | List private channels |
| `im:history` | Read direct messages |
| `im:read` | List DM conversations |
| `mpim:history` | Read group direct messages |
| `mpim:read` | List group DM conversations |
| `users:read` | Read workspace member profiles |
| `users:read.email` | Read member email addresses |
| `files:read` | Access shared files |

## How Sync Works

1. **List channels** -- fetches all channels (public, private, DMs, group DMs) accessible by the user
2. **Fetch messages** -- for each channel, pulls the full message history using `conversations.history`
3. **Resolve profiles** -- fetches user profiles for all workspace members using `users.list`
4. **Emit events** -- each message becomes a `ConnectorDataEvent` with:
   - `sourceType: 'message'`
   - `participants`: array of usernames
   - `metadata.channel`: channel name
   - `metadata.participantProfiles`: map of username to profile data (name, email, phone, title, avatar)

### Contact Resolution

During embedding, the processor:
- Looks up each participant's profile from the `participantProfiles` metadata
- Creates identifiers for `slack_id`, `email`, `phone`, and `name`
- Merges with existing contacts that share the same email or phone

### File Processing

When a message contains shared files, the sync emits separate `file` events. The file processor downloads them via the Slack API (using the access token) and extracts content for:
- Images (via Ollama VL model)
- PDFs (via `pdf-parse`)
- Documents (via `mammoth`)
- Spreadsheets (via `xlsx`)
- Plain text files

## Troubleshooting

### "not_authed" error

The user token may have expired or been revoked. Get a new token from the Slack app settings.

### Missing private channels

Ensure the `groups:history` and `groups:read` scopes are added to the app. The user token only has access to channels the user is a member of.

### Rate limiting

Slack's API has rate limits (tier 3 for most methods). The connector handles rate limit responses with exponential backoff. For very large workspaces, the initial sync may take several minutes.
