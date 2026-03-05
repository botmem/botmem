# Connectors & Accounts API

## List Connectors

Returns all registered connector types with their manifests.

```
GET /api/connectors
```

### Response

```json
{
  "connectors": [
    {
      "id": "gmail",
      "name": "Google",
      "description": "Import emails, contacts, and attachments from Google",
      "color": "#FF6B9D",
      "icon": "mail",
      "authType": "oauth2",
      "configSchema": {
        "type": "object",
        "properties": {
          "clientId": { "type": "string", "title": "Google Client ID" },
          "clientSecret": { "type": "string", "title": "Google Client Secret" },
          "redirectUri": { "type": "string", "title": "Redirect URI" }
        },
        "required": ["clientId", "clientSecret"]
      }
    },
    {
      "id": "slack",
      "name": "Slack",
      "description": "Import messages and files from Slack",
      "color": "#4A154B",
      "icon": "message-square",
      "authType": "api-key",
      "configSchema": { ... }
    }
  ]
}
```

---

## Get Config Schema

Returns the configuration schema for a specific connector type. This schema describes what fields the user needs to provide for authentication.

```
GET /api/connectors/:type/schema
```

### Response

```json
{
  "schema": {
    "type": "object",
    "properties": {
      "clientId": { "type": "string", "title": "Google Client ID" },
      "clientSecret": { "type": "string", "title": "Google Client Secret" },
      "redirectUri": { "type": "string", "title": "Redirect URI", "default": "http://localhost:3001/api/auth/gmail/callback" }
    },
    "required": ["clientId", "clientSecret"]
  }
}
```

---

## Get Connector Status

Returns the current status of a connector.

```
GET /api/connectors/:type/status
```

### Response

```json
{
  "ready": true,
  "status": "available"
}
```

---

## List Accounts

Returns all connected accounts across all connector types.

```
GET /api/accounts
```

### Response

```json
{
  "accounts": [
    {
      "id": "account-uuid",
      "type": "gmail",
      "identifier": "user@gmail.com",
      "status": "connected",
      "schedule": "manual",
      "lastSync": "2026-02-15T10:30:00Z",
      "memoriesIngested": 8500,
      "lastError": null
    }
  ]
}
```

### Account Status Values

| Status | Description |
|---|---|
| `disconnected` | Not yet authenticated |
| `connected` | Authenticated and ready to sync |
| `syncing` | Currently running a sync job |
| `error` | Last sync failed |

### Schedule Values

| Schedule | Description |
|---|---|
| `manual` | Sync only when triggered |

---

## Get Account

```
GET /api/accounts/:id
```

### Response

Returns a single account object (same shape as list items).

---

## Create Account

Creates a new account for a connector type.

```
POST /api/accounts
```

### Request Body

```json
{
  "connectorType": "gmail",
  "identifier": "user@gmail.com"
}
```

### Response

Returns the created account object.

---

## Update Account

```
PATCH /api/accounts/:id
```

### Request Body

```json
{
  "schedule": "manual"
}
```

### Response

Returns the updated account object.

---

## Delete Account

Removes an account and its stored credentials.

```
DELETE /api/accounts/:id
```

### Response

```json
{
  "ok": true
}
```

---

## Auth Endpoints

### Check for Saved Credentials

```
GET /api/auth/:type/has-credentials
```

**Response:**
```json
{
  "hasSavedCredentials": true
}
```

### Initiate Auth Flow

Starts the authentication flow for a connector type.

```
POST /api/auth/:type/initiate
```

**Request Body:**
```json
{
  "config": {
    "clientId": "your-client-id",
    "clientSecret": "your-client-secret"
  }
}
```

**Response (OAuth 2.0):**
```json
{
  "type": "redirect",
  "url": "https://accounts.google.com/o/oauth2/v2/auth?..."
}
```

**Response (QR Code):**
```json
{
  "type": "qr-code",
  "qrData": "2@abc123...",
  "wsChannel": "whatsapp:session-id"
}
```

**Response (API Key):**
```json
{
  "type": "complete",
  "auth": {
    "accessToken": "...",
    "identifier": "user@example.com"
  }
}
```

### OAuth Callback

Handles the OAuth redirect callback. This endpoint is called by the external service (e.g., Google) after the user grants permission.

```
GET /api/auth/:type/callback?code=...&state=...
```

Redirects the user back to the frontend with `?auth=success&type=gmail`.

### Complete Auth

Finalize the auth flow for non-redirect auth types.

```
POST /api/auth/:type/complete
```

**Request Body:**
```json
{
  "accountId": "existing-account-uuid",
  "params": {
    "code": "auth-code",
    "clientId": "...",
    "clientSecret": "..."
  }
}
```
