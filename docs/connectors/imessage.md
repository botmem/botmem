# iMessage Connector

The iMessage connector reads your macOS iMessage database and syncs conversations to Botmem. It supports two modes: **Remote Bridge** (recommended) for syncing from any Mac over an encrypted tunnel, and **Local** for when the Botmem server runs on the same machine.

**Auth type:** Local Tool / Bridge Token
**Trust score:** 0.80
**Source types:** `message`

## What It Syncs

- **iMessages** -- messages sent via iMessage (blue bubbles)
- **SMS** -- SMS/MMS messages stored in the same database (green bubbles)
- **Group chats** -- messages from group conversations
- **Participants** -- phone numbers and email addresses (iMessage handles)
- **Reactions** -- tapback reactions (love, like, dislike, laugh, emphasis, question)

## Remote Bridge Setup (Recommended)

The remote bridge lets you sync iMessages from any Mac to your Botmem server over an encrypted WebSocket tunnel. No port forwarding or VPN required.

### Prerequisites

- **macOS** with iMessage signed in
- **Node.js 20+** installed
- **Full Disk Access** for your terminal (see below)

### 1. Grant Full Disk Access

The iMessage database at `~/Library/Messages/chat.db` is protected by macOS. Grant access:

1. Open **System Settings > Privacy & Security > Full Disk Access**
2. Add your terminal app (Terminal.app, iTerm2, Warp, etc.)
3. Restart the terminal

### 2. Connect via Dashboard

1. Navigate to **Connectors** and click **+** on the iMessage connector
2. Enter your iMessage email or phone number
3. Click **Generate Bridge Command**
4. Copy the one-liner command shown in the dashboard

### 3. Run the Bridge

Run the command on your Mac:

```bash
npx @botmem/imsg-bridge --token=<your-token> --server=wss://your-botmem-server/imsg-tunnel
```

The bridge will:

- Verify macOS and Full Disk Access
- Open the iMessage database (read-only)
- Connect to your Botmem server via encrypted WebSocket
- Wait for sync requests

### 4. Start Syncing

Once the dashboard shows **Bridge Connected**, click **Start Sync**. The bridge relays encrypted JSON-RPC queries from the server to your local iMessage database.

### Security

- **Transport encryption**: WSS (TLS) protects the WebSocket connection
- **Payload encryption**: Every JSON-RPC message is encrypted with AES-256-GCM using a per-session key derived via ECDH (X25519) key exchange
- **Token auth**: Bridge tokens are opaque, single-use-bind, and stored encrypted on the server
- **Read-only**: The bridge never writes to your iMessage database
- **No data stored on bridge**: The bridge is a stateless relay -- your messages flow encrypted to the server, nothing is cached locally

### Running as a Background Service

To keep the bridge running persistently:

```bash
# Using launchd (macOS native)
# Create ~/Library/LaunchAgents/com.botmem.imsg-bridge.plist

# Using pm2
pm2 start "npx @botmem/imsg-bridge --token=<token> --server=wss://..." --name imsg-bridge
```

The bridge auto-reconnects with exponential backoff if the connection drops.

## Local Setup (Advanced)

If the Botmem server runs on the same Mac as iMessage, you can use the local TCP mode:

1. Navigate to **Connectors** and configure:
   - **Your Email or Phone**: your iMessage identifier
   - **Bridge Host**: `localhost` (default)
   - **Bridge Port**: `19876` (default)
2. Start the bridge: `socat TCP-LISTEN:19876,reuseaddr,fork EXEC:"imsg rpc"`
3. Click **Connect**

## How Sync Works

1. Opens `~/Library/Messages/chat.db` in read-only mode via `better-sqlite3`
2. Queries `chat`, `message`, `handle`, and `attachment` tables
3. For each message:
   - Converts Core Data timestamps to ISO 8601
   - Resolves sender/recipient handles
   - Filters noise (delivery receipts, tapback reactions, empty messages)
4. Emits `ConnectorDataEvent` with `sourceType: 'message'`
5. Uses timestamps as cursors for incremental sync

## Contact Resolution

The embed processor resolves iMessage participants using:

- **Email addresses** -- if the handle contains `@`, treated as email
- **Phone numbers** -- otherwise, treated as a phone number
- The `isFromMe` flag determines `sender` vs `recipient` role
- Group chats create a `group` entity with the chat name

## Limitations

- **macOS only** -- the iMessage database does not exist on other platforms
- **Text + metadata only** -- file attachments are detected but not transferred through the tunnel
- **Read-only** -- Botmem never writes to the iMessage database
- **Manual sync** -- sync must be triggered from the dashboard; no real-time file watcher

## Troubleshooting

### "SQLITE_CANTOPEN" or permission error

Grant Full Disk Access to your terminal app in System Settings, then restart the terminal.

### Bridge shows "Invalid token"

The token may have been regenerated. Go to Connectors in the dashboard, delete the iMessage account, and create a new one to get a fresh token.

### Bridge keeps reconnecting

Check that your Botmem server is reachable. The bridge auto-reconnects with backoff (1s, 2s, 4s... up to 30s).

### Missing recent messages

iMessage may take a moment to write new messages to the database. Wait a few seconds and re-sync.

### Duplicate contacts

If a contact uses both a phone number and email for iMessage, they may appear as separate contacts. The contact merge feature will identify these duplicates.
