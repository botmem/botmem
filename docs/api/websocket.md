# WebSocket Events

Botmem provides a WebSocket gateway at `/events` for real-time updates. The gateway uses the native `ws` (WebSocket) protocol, not Socket.IO.

## Connection

```javascript
const ws = new WebSocket('ws://localhost:12412/events');

ws.onopen = () => {
  console.log('Connected to Botmem events');
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Event:', data);
};
```

## Channel Subscription

After connecting, subscribe to channels to receive events. Send a JSON message with the `subscribe` event:

```javascript
// Subscribe to log events
ws.send(
  JSON.stringify({
    event: 'subscribe',
    data: { channel: 'logs' },
  }),
);

// Subscribe to memory events
ws.send(
  JSON.stringify({
    event: 'subscribe',
    data: { channel: 'memories' },
  }),
);

// Unsubscribe
ws.send(
  JSON.stringify({
    event: 'unsubscribe',
    data: { channel: 'logs' },
  }),
);
```

## Channels

### `logs`

Receives real-time log entries from all pipeline stages.

**Event: `log`**

```json
{
  "channel": "logs",
  "event": "log",
  "data": {
    "connectorType": "gmail",
    "accountId": "account-uuid",
    "stage": "embed",
    "level": "info",
    "message": "[embed:done] a1b2c3d4 in 450ms -- db=5ms contacts=120ms(3) ollama=280ms(1024d) qdrant=45ms",
    "timestamp": "2026-02-15T10:15:30Z"
  }
}
```

### `memories`

Receives events when memories are created or updated.

**Event: `memory:updated`**

```json
{
  "channel": "memories",
  "event": "memory:updated",
  "data": {
    "memoryId": "memory-uuid",
    "sourceType": "photo",
    "connectorType": "photos",
    "text": "A group photo at a restaurant with three people..."
  }
}
```

### `jobs`

Receives job status updates.

**Event: `job:progress`**

```json
{
  "channel": "jobs",
  "event": "job:progress",
  "data": {
    "jobId": "job-uuid",
    "progress": 150,
    "total": 8500
  }
}
```

**Event: `job:complete`**

```json
{
  "channel": "jobs",
  "event": "job:complete",
  "data": {
    "jobId": "job-uuid",
    "status": "done"
  }
}
```

## Implementation Details

The WebSocket gateway is implemented using NestJS's `@WebSocketGateway` decorator with the `ws` library (not Socket.IO). Key characteristics:

- **Path:** `/events`
- **Protocol:** Native WebSocket (ws://)
- **Subscription model:** Client subscribes to named channels; server only sends events for subscribed channels
- **Authentication:** WebSocket connections require a valid token passed as a query parameter (`?token=...`)
- **Reconnection:** Not handled server-side; clients should implement their own reconnection logic

## Example: Monitoring Sync Progress

```javascript
const ws = new WebSocket('ws://localhost:12412/events');

ws.onopen = () => {
  // Subscribe to all relevant channels
  ws.send(JSON.stringify({ event: 'subscribe', data: { channel: 'jobs' } }));
  ws.send(JSON.stringify({ event: 'subscribe', data: { channel: 'logs' } }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  switch (msg.event) {
    case 'job:progress':
      const pct = ((msg.data.progress / msg.data.total) * 100).toFixed(1);
      console.log(`Sync progress: ${pct}%`);
      break;

    case 'job:complete':
      console.log(`Sync ${msg.data.status}`);
      break;

    case 'log':
      if (msg.data.level === 'error') {
        console.error(`[${msg.data.stage}] ${msg.data.message}`);
      }
      break;
  }
};
```
