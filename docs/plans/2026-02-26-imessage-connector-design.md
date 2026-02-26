# iMessage Connector — socat + imsg RPC Design

## Problem

The current iMessage connector uses `imessage-exporter` CLI which only works natively on macOS. Botmem needs to run in Docker, so we need a bridge to access iMessage data from within a container.

## Approach: socat TCP bridge + imsg RPC

### Architecture

```
Mac Host                              Docker Container
┌──────────────────────┐              ┌──────────────────────────┐
│  socat TCP:19876     │◄────TCP─────►│  IMessageConnector       │
│    ↕ stdio           │              │  (connects to host:19876)│
│  imsg rpc            │              │                          │
│  (reads chat.db)     │              │  JSON-RPC 2.0 over TCP   │
└──────────────────────┘              └──────────────────────────┘
```

**Host side**: `socat TCP-LISTEN:19876,reuseaddr,fork EXEC:"imsg rpc"` — spawns one `imsg rpc` process per TCP connection.

**Docker side**: Connector opens TCP socket to `host.docker.internal:19876`, sends JSON-RPC 2.0 requests (newline-delimited JSON), reads responses.

### imsg RPC Protocol

Transport: stdin/stdout, newline-delimited JSON-RPC 2.0. Over socat, this becomes TCP with same framing.

Methods used:
- `chats.list` — list all conversations (returns chat id, name, participants, last_message_at)
- `messages.history` — fetch messages for a chat (params: chat_id, limit, start/end dates)

### Connector Config Schema

```json
{
  "imsgHost": { "type": "string", "default": "host.docker.internal", "title": "imsg Bridge Host" },
  "imsgPort": { "type": "number", "default": 19876, "title": "imsg Bridge Port" }
}
```

Auth type remains `local-tool`. Auth validation = successful `chats.list` ping.

### Sync Strategy

1. Connect TCP to imsg bridge
2. `chats.list` with high limit to get all conversations
3. For each chat: `messages.history` with `start` = last cursor timestamp (or epoch for first sync)
4. Emit `ConnectorDataEvent` per message with: text, participants, timestamp, isFromMe, chatId, attachments
5. Store last message timestamp as cursor for incremental sync
6. Full history on first sync (no limit)

### Files Changed

- **Delete**: `packages/connectors/imessage/src/exporter.ts`
- **Create**: `packages/connectors/imessage/src/imsg-client.ts` — TCP JSON-RPC client
- **Rewrite**: `packages/connectors/imessage/src/index.ts` — use imsg-client for sync/auth
- **Rewrite**: `packages/connectors/imessage/src/__tests__/imessage.test.ts` — new mocks

### Event Format (unchanged)

```ts
{
  sourceType: 'message',
  sourceId: msg.guid || `imsg-${msg.id}`,
  timestamp: msg.created_at,
  content: {
    text: msg.text,
    participants: msg.participants || [msg.sender],
    metadata: {
      chatId: msg.chat_id,
      chatName: msg.chat_name,
      service: 'iMessage',
      isFromMe: msg.is_from_me,
      isGroup: msg.is_group,
    },
  },
}
```
