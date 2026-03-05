# iMessage Connector

The iMessage connector reads your local iMessage database on macOS. No external authentication is needed -- it reads directly from the SQLite database that macOS maintains.

**Auth type:** Local Tool
**Trust score:** 0.80
**Source types:** `message`

## What It Syncs

- **iMessages** -- messages sent via iMessage (blue bubbles)
- **SMS** -- SMS/MMS messages stored in the same database (green bubbles)
- **Group chats** -- messages from group conversations
- **Participants** -- phone numbers and email addresses (iMessage handles)

## Prerequisites

- **macOS** -- this connector only works on macOS
- **Full Disk Access** -- the process running Botmem needs Full Disk Access permission to read the iMessage database
- **imsg bridge** -- Botmem uses an iMessage bridge tool to read the database

## Setup

### 1. Grant Full Disk Access

The iMessage database is located at `~/Library/Messages/chat.db`. macOS restricts access to this file. To grant access:

1. Open **System Settings > Privacy & Security > Full Disk Access**
2. Add your terminal application (Terminal.app, iTerm2, etc.) or the Node.js binary
3. Restart the terminal

### 2. Configure in Botmem

Navigate to the Connectors page and click **Add** on the iMessage connector. No credentials are needed -- just confirm the setup.

## How Sync Works

1. Opens the iMessage SQLite database at `~/Library/Messages/chat.db` in read-only mode
2. Queries the `message` table joined with `chat` and `handle` tables
3. For each message, extracts:
   - Message text content
   - Sender/recipient handle (phone number or email)
   - Chat identifier (for group chats)
   - Timestamp
   - `is_from_me` flag
4. Emits a `ConnectorDataEvent` with `sourceType: 'message'`
5. Uses timestamps as cursors for incremental sync

## Contact Resolution

The embed processor resolves iMessage participants using:
- **Email addresses** -- if the handle contains `@`, it is treated as an email
- **Phone numbers** -- otherwise, the handle is treated as a phone number
- Both are also stored as `imessage_handle` type identifiers
- The `isFromMe` flag determines whether the participant is tagged as `sender` or `recipient`

## Limitations

- **macOS only** -- the iMessage database does not exist on other platforms
- **Text only** -- attachments (images, videos) are not currently extracted
- **Read-only** -- Botmem never writes to the iMessage database
- **No real-time** -- sync must be triggered manually; there is no file watcher for new messages

## Troubleshooting

### "SQLITE_CANTOPEN" error

The process does not have permission to read `~/Library/Messages/chat.db`. Grant Full Disk Access to the terminal or Node.js binary.

### Missing recent messages

iMessage may take a moment to write new messages to the database. Wait a few seconds and re-sync.

### Duplicate contacts

If a contact uses both a phone number and an email address for iMessage, they may appear as separate contacts initially. The contact merge suggestions feature will identify these duplicates.
