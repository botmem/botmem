# Telegram Connector

The Telegram connector imports messages and contacts from your Telegram account using the [GramJS](https://github.com/nicedoc/gramjs) client library.

**Auth type:** Phone code (SMS/app verification + optional 2FA)
**Trust score:** 0.8
**Source types:** `message`

## What It Syncs

- **Messages** -- text messages from all private chats and groups (broadcast channels and bots are skipped)
- **Media** -- photos and files attached to messages (base64-encoded, max 20MB per file)
- **Contacts** -- your Telegram contacts with name, phone number, and username

## Setup

### 1. Configure in Botmem

Navigate to the Connectors page and click **Add** on the Telegram connector. Enter:

| Field                 | Value                                                                    |
| --------------------- | ------------------------------------------------------------------------ |
| Phone Number          | Your Telegram phone number in international format (e.g., `+1234567890`) |
| API ID _(optional)_   | Custom API ID from [my.telegram.org/apps](https://my.telegram.org/apps)  |
| API Hash _(optional)_ | Custom API Hash from the same page                                       |

::: tip
API ID and API Hash are optional. The connector ships with default credentials that work for most users. Only provide custom ones if you want to use your own Telegram application.
:::

### 2. Authenticate

1. Click **Connect** -- Telegram sends a verification code to your phone
2. Enter the code in the Botmem UI
3. If you have **Two-Factor Authentication** enabled, you'll be prompted to enter your 2FA password

The session is saved and reused for future syncs. You don't need to re-authenticate unless you revoke the session from Telegram's active sessions list.

## Configuration Schema

```json
{
  "type": "object",
  "properties": {
    "phone": {
      "type": "string",
      "title": "Phone Number",
      "description": "+1234567890"
    },
    "apiId": {
      "type": "string",
      "title": "API ID (optional)",
      "description": "From my.telegram.org/apps"
    },
    "apiHash": {
      "type": "string",
      "title": "API Hash (optional)",
      "description": "From my.telegram.org/apps"
    }
  },
  "required": ["phone"]
}
```

## How Sync Works

### Message Sync

1. Fetches all dialogs (conversations) from your account
2. Skips broadcast channels and bot conversations
3. For each dialog, fetches messages in batches of 100
4. Downloads media attachments as base64 inline data
5. Tracks per-dialog cursors for incremental sync (only new messages on subsequent syncs)
6. Built-in FLOOD_WAIT handling with exponential backoff + jitter

### Contact Sync

After messages, the connector fetches your Telegram contacts via the API and emits them as contact events. Bot contacts are skipped.

### Contact Resolution

Entities are extracted from each message:

- **Sender** identified by phone number (primary), username, or Telegram ID (fallback)
- **Group** identified by chat ID and group name

## Troubleshooting

### FLOOD_WAIT errors

Telegram rate-limits API calls. The connector handles this automatically by sleeping for the required duration plus random jitter. If you see repeated FLOOD_WAIT warnings in the logs, the sync is still running — it's just throttled.

### "No pending auth session" error

The authentication session expires after 5 minutes. If you see this error, restart the authentication flow from the Connectors page.

### 2FA password prompt

If your Telegram account has Two-Factor Authentication enabled, you'll be prompted for your cloud password after entering the verification code. This is expected behavior.

### Session revoked

If a sync fails with a session error, your Telegram session may have been revoked (e.g., from Telegram's Settings > Devices > Terminate session). Re-authenticate from the Connectors page to create a new session.
