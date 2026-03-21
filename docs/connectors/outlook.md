# Outlook

The Outlook connector imports emails and contacts from Microsoft 365 / Outlook.com using the Microsoft Graph API.

## Auth Type

**OAuth 2.0** — requires a Microsoft Azure AD app registration with Graph API permissions.

## What It Syncs

| Data     | Source Type | Description                                                                   |
| -------- | ----------- | ----------------------------------------------------------------------------- |
| Emails   | `email`     | Messages from the user's mailbox with participants, subject, and body         |
| Contacts | `contact`   | People from the user's Outlook contacts with name, email, phone, organization |

## Setup

### 1. Create an Azure AD App

1. Go to [Azure Portal](https://portal.azure.com) → Azure Active Directory → App registrations
2. Click **New registration**
3. Set the redirect URI to `http://localhost:12412/api/auth/outlook/callback` (or your production URL)
4. Under **API permissions**, add:
   - `Microsoft Graph` → `Mail.Read` (delegated)
   - `Microsoft Graph` → `Contacts.Read` (delegated)
5. Under **Certificates & secrets**, create a new client secret

### 2. Configure in Botmem

In the Botmem web UI, go to **Connectors → Add Outlook** and enter:

| Field         | Description                                           |
| ------------- | ----------------------------------------------------- |
| Client ID     | Application (client) ID from Azure AD                 |
| Client Secret | Client secret value                                   |
| Tenant ID     | Directory (tenant) ID — use `common` for multi-tenant |

## Sync Behavior

- **Emails**: Fetches all messages from the user's mailbox using Microsoft Graph `/me/messages`. Supports incremental sync via cursor (timestamp-based).
- **Contacts**: Fetches all contacts from `/me/contacts` with deduplication to handle Graph API pagination loops.
- **Token refresh**: Automatically refreshes expired OAuth tokens during sync using the stored refresh token.

## Trust Score

**0.90** — Enterprise email with verified sender identity.
