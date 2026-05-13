# iMessage Connector

The iMessage connector reads Apple Contacts and your local macOS Messages database through the Botmem Apple Bridge. The bridge runs on your Mac and connects to Botmem over an encrypted WebSocket tunnel.

**Auth type:** Local Tool / Bridge Token
**Trust score:** 0.80
**Source types:** `contact`, `message`

## What It Syncs

- **Apple Contacts** -- names, email addresses, phone numbers, and basic metadata
- **iMessages** -- messages sent via iMessage
- **SMS/MMS** -- messages stored in the same macOS Messages database
- **Group chats** -- group names, participants, and messages
- **Participants** -- phone numbers and email addresses from Messages handles

## Setup

### 1. Create the Apple connector

1. Open **Connectors** in Botmem.
2. Click **+** on the Apple connector.
3. Enter your iMessage email or phone number.
4. Choose **Contacts**, **iMessages**, or both.
5. Click **Generate Bridge Command**.

### 2. Install Botmem Apple Bridge

Download the latest signed DMG from GitHub Releases:

```text
https://github.com/botmem/botmem/releases/latest
```

Use the asset for your Mac:

- Apple Silicon: `Botmem-Apple-Bridge-arm64.dmg`
- Intel: `Botmem-Apple-Bridge-x64.dmg`

Open the app after installing it.

### 3. Connect the app

In the Botmem dashboard, click **Connect Bridge App**. macOS opens Botmem Apple Bridge through this URL scheme:

```text
botmem-apple-bridge://connect
```

The app stores the bridge config locally at:

```text
~/Library/Application Support/Botmem Apple Bridge/config.json
```

The file is written with user-only permissions and lets the app reconnect after restarts.

The app also installs a per-user LaunchAgent:

```text
~/Library/LaunchAgents/xyz.botmem.apple-bridge.service.plist
```

That service starts at login, stays connected to Botmem, and reconnects automatically if the network drops. The bridge token is read from the local config file, not passed as a command-line argument.

### 4. Use the bridge window

Botmem Apple Bridge opens a small native status window. It shows:

- current service state
- selected Apple sources
- connected Botmem server
- actions to restart the service, open Full Disk Access, or remove the service

Double-clicking the app should always show this window.

### 5. Grant permissions

- **Contacts only:** macOS shows the normal Contacts permission prompt. Full Disk Access is not required.
- **iMessages:** macOS may block the Messages database until you grant Full Disk Access to **Botmem Apple Bridge**.

To grant iMessage access:

1. Open **System Settings > Privacy & Security > Full Disk Access**.
2. Enable **Botmem Apple Bridge**.
3. Restart Botmem Apple Bridge.

Shortcut:

```bash
open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
```

Once the dashboard shows **Bridge Connected**, click **Start Sync**.

## Advanced CLI Fallback

The dashboard also shows an advanced CLI command:

```bash
npx @botmem/apple-bridge --token=<your-token> --server=wss://your-botmem-server/apple-tunnel --sources=contacts,imessages
```

Use this only if you do not want to install the macOS app. If syncing iMessages through the CLI, grant Full Disk Access to the terminal app that runs the command.

For Contacts-only sync:

```bash
npx @botmem/apple-bridge --token=<your-token> --server=wss://your-botmem-server/apple-tunnel --sources=contacts
```

Contacts-only mode does not open `~/Library/Messages/chat.db`.

## Why Full Disk Access?

Apple does not provide a public Messages history API or a narrow permission for `~/Library/Messages/chat.db`. Historical iMessage sync requires reading that protected local SQLite database. Botmem opens it read-only and never writes to Apple databases.

Full Disk Access is only needed for iMessage history. Apple Contacts uses the native Contacts permission prompt.

## Security

- **Transport encryption:** WSS/TLS protects the WebSocket connection.
- **Payload encryption:** JSON-RPC messages are encrypted with AES-256-GCM using a per-session key derived via ECDH/X25519.
- **Token auth:** Bridge tokens are opaque and stored encrypted on the server.
- **Local token handling:** The macOS app stores bridge config in a user-only local config file.
- **Read-only Messages access:** The bridge never writes to `chat.db`.
- **No local message cache:** The bridge relays data and does not keep a message cache.

## Revoke Access

To revoke Messages access:

1. Open **System Settings > Privacy & Security > Full Disk Access**.
2. Disable **Botmem Apple Bridge**.
3. Quit Botmem Apple Bridge.

To remove the local bridge token, delete:

```text
~/Library/Application Support/Botmem Apple Bridge/config.json
```

Then delete the Apple connector account in Botmem and remove the app from your Mac.

To remove the background service without deleting the connector, open Botmem Apple Bridge and click **Remove Service**.

## Troubleshooting

### macOS blocked Messages access

Grant Full Disk Access to **Botmem Apple Bridge**, then restart the app. If using the CLI fallback, grant access to your terminal app instead.

### Bridge shows "Invalid token"

The token may have been regenerated. Delete the Apple connector account and create a new one to get a fresh token.

### Bridge keeps reconnecting

Check that your Botmem server is reachable. The bridge reconnects with backoff if the connection drops.

### Missing recent messages

Messages may take a moment to write new messages to the local database. Wait a few seconds and sync again.

### Duplicate contacts

If a contact uses both a phone number and email for iMessage, they may appear as separate contacts until contact merge resolves them.
