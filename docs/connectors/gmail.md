# Gmail / Google Connector

The Gmail connector imports emails, contacts, and attachments from Google using OAuth 2.0.

**Auth type:** OAuth 2.0
**Trust score:** 0.95
**Source types:** `email` (messages), `file` (contacts)

## What It Syncs

- **Emails** -- full message body (text content, HTML stripped), sender, recipients (To, CC), subject, date
- **Google Contacts** -- names, emails, phone numbers, organizations, addresses, birthdays, photos, and all metadata from the People API
- **Attachments** -- routed to the file processor for content extraction (PDFs, images, documents)

## Setup

### 1. Create Google OAuth Credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Navigate to **APIs & Services > Credentials**
4. Click **Create Credentials > OAuth client ID**
5. Select **Web application**
6. Add `http://localhost:3001/api/auth/gmail/callback` as an **Authorized redirect URI**
7. Copy the **Client ID** and **Client Secret**

### 2. Enable Required APIs

In the Google Cloud Console, enable:
- **Gmail API** (`gmail.googleapis.com`)
- **People API** (`people.googleapis.com`)

### 3. Configure in Botmem

Navigate to the Connectors page in the web UI and click **Add** on the Google connector. Enter:

| Field | Value |
|---|---|
| Client ID | Your Google OAuth Client ID |
| Client Secret | Your Google OAuth Client Secret |
| Redirect URI | `http://localhost:3001/api/auth/gmail/callback` (default) |

### 4. Authorize

Click **Connect** to be redirected to Google's consent screen. Grant access to:
- Read your email messages and settings (`gmail.readonly`)
- See and download your contacts (`contacts.readonly`)

After authorization, you will be redirected back to Botmem.

## Configuration Schema

```json
{
  "type": "object",
  "properties": {
    "clientId": {
      "type": "string",
      "title": "Google Client ID"
    },
    "clientSecret": {
      "type": "string",
      "title": "Google Client Secret"
    },
    "redirectUri": {
      "type": "string",
      "title": "Redirect URI",
      "default": "http://localhost:3001/api/auth/gmail/callback"
    }
  },
  "required": ["clientId", "clientSecret"]
}
```

## OAuth Scopes

| Scope | Purpose |
|---|---|
| `https://www.googleapis.com/auth/gmail.readonly` | Read email messages and metadata |
| `https://www.googleapis.com/auth/contacts.readonly` | Read Google Contacts (People API) |

## How Sync Works

### Email Sync

1. Lists all message IDs using the Gmail API `messages.list` endpoint
2. Fetches each message with `messages.get` (format: full)
3. Extracts text content, stripping HTML when necessary
4. Emits a `ConnectorDataEvent` with `sourceType: 'email'` and metadata including `from`, `to`, `cc`, `subject`
5. Uses a cursor (Gmail page token) for incremental sync

### Contact Sync

1. Lists all contacts using the People API `people.connections.list`
2. Requests all available fields: names, emails, phones, organizations, addresses, birthdays, photos, URLs, etc.
3. Emits each contact as a `ConnectorDataEvent` with rich metadata
4. Downloads Google profile photos and stores them as base64 avatars on the contact record

### Contact Resolution

During embedding, the processor:
- Parses `From`, `To`, and `CC` headers to extract email addresses and display names
- Creates or merges contacts using email as the primary identifier
- Links contacts to memories with roles: `sender`, `recipient`
- For Google Contacts, stores all metadata (organizations, birthday, addresses, etc.) directly on the contact record

## Troubleshooting

### "Access blocked" error during authorization

Make sure your OAuth consent screen is configured and your Google account is added as a test user (if the app is in testing mode).

### Token refresh failures

Gmail tokens expire after 1 hour. Botmem stores the refresh token and automatically refreshes the access token. If the refresh token is revoked, you will need to re-authorize.

### Missing contacts

The People API only returns contacts that the user has explicitly saved. It does not include "Other contacts" (auto-saved from email interactions) unless you use a different API scope.
