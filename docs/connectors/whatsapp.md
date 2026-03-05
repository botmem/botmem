# WhatsApp Connector

The WhatsApp connector imports chat messages and group conversations using the Baileys library (unofficial WhatsApp Web API).

**Auth type:** QR Code
**Trust score:** 0.80
**Source types:** `message`

## What It Syncs

- **Direct messages** -- one-on-one chat messages with text content
- **Group messages** -- messages from WhatsApp groups
- **Message history** -- historical messages delivered via WhatsApp's history sync protocol

## Setup

### 1. Link via QR Code

1. Navigate to the Connectors page in the web UI
2. Click **Add** on the WhatsApp connector
3. A QR code will be displayed
4. Open WhatsApp on your phone, go to **Linked Devices**, and scan the QR code
5. Wait for the connection to establish

### 2. History Sync

After linking, WhatsApp delivers your message history in batches. This only happens on the **first connection** -- subsequent reconnections do not receive history.

::: warning Important
History is **only delivered to the first socket that links** via QR code. If you disconnect and reconnect, you will only receive new messages going forward, not historical ones. To get full history, delete the session and re-link.
:::

## Technical Details

### Baileys Library

Botmem uses [Baileys v7](https://github.com/WhiskeySockets/Baileys) (`@whiskeysockets/baileys@7.0.0-rc.9`), an ESM-only library that implements the WhatsApp Web protocol.

### Session Management

Session files are stored under `apps/api/data/whatsapp/wa-session-*`. These files maintain the encryption keys for the WhatsApp connection. Do not delete them while the server is running.

### LID Format

WhatsApp uses an opaque identifier format called LID (`@lid`) instead of phone numbers for internal routing. Botmem resolves LIDs to phone numbers using Baileys' signal repository:

```typescript
// Resolve LID to phone number
const phoneJid = await sock.signalRepository.lidMapping.getLIDForPN(phoneJid);
// Or the reverse
const lid = await sock.signalRepository.lidMapping.getPNForLID(lidJid);
```

### History Sync Behavior

- The `isLatest` flag in history sync events is unreliable (it arrives first with 0 messages)
- Botmem uses an idle timeout instead to determine when history sync is complete
- Messages arrive in batches and are processed as they come in

## Contact Resolution

The embed processor resolves WhatsApp participants using:
- **Phone numbers** as the primary identifier (extracted from JID or metadata)
- **Sender names** (push names from WhatsApp) as secondary identifiers
- Group JIDs (containing `-`) are skipped for contact resolution
- For DMs, both the sender and recipient are resolved as contacts

## Limitations

- **No media** -- the connector currently syncs text messages only; images, videos, and voice notes are not downloaded
- **No reactions** -- message reactions are not captured
- **History once** -- message history is only delivered on the first QR link; re-linking only gets new messages
- **Session sensitivity** -- deleting session files while the server references them causes ENOENT crashes
- **Rate limits** -- WhatsApp may temporarily ban accounts that sync too aggressively; the connector paces itself

## Troubleshooting

### QR code not appearing

Make sure the API server is running and the WebSocket connection to `/events` is established.

### "Connection closed" after linking

This can happen if another device is already linked with the same session. Delete the session files in `apps/api/data/whatsapp/` and re-link.

### No history received

History is only delivered on the first QR link. If you previously linked and then disconnected, delete the session directory and start fresh.
