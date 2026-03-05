# Jobs API

Jobs track sync operations and their progress. Each sync creates a job record that persists its status, progress, and any errors.

## List Jobs

```
GET /api/jobs
```

### Query Parameters

| Parameter | Type | Description |
|---|---|---|
| `accountId` | string | Filter by account ID |

### Response

```json
{
  "jobs": [
    {
      "id": "job-uuid",
      "connector": "gmail",
      "accountId": "account-uuid",
      "accountIdentifier": "user@gmail.com",
      "status": "done",
      "priority": 0,
      "progress": 8500,
      "total": 8500,
      "startedAt": "2026-02-15T10:00:00Z",
      "completedAt": "2026-02-15T10:30:00Z",
      "error": null
    }
  ]
}
```

### Job Status Values

| Status | Description |
|---|---|
| `queued` | Waiting in the sync queue |
| `running` | Currently executing |
| `done` | Completed successfully |
| `failed` | Completed with an error |
| `cancelled` | Cancelled by user |

---

## Get Queue Statistics

Returns the current state of all BullMQ processing queues.

```
GET /api/jobs/queues
```

### Response

```json
{
  "sync": {
    "waiting": 0,
    "active": 1,
    "completed": 15,
    "failed": 0,
    "delayed": 0
  },
  "embed": {
    "waiting": 120,
    "active": 4,
    "completed": 8500,
    "failed": 3,
    "delayed": 0
  },
  "enrich": {
    "waiting": 50,
    "active": 2,
    "completed": 8400,
    "failed": 5,
    "delayed": 0
  },
  "backfill": {
    "waiting": 0,
    "active": 0,
    "completed": 200,
    "failed": 0,
    "delayed": 0
  }
}
```

This endpoint is useful for monitoring pipeline throughput and identifying bottlenecks.

---

## Get Job

```
GET /api/jobs/:id
```

### Response

Returns a single job object, or `{"error": "not found"}` if the ID does not exist.

---

## Trigger Sync

Starts a sync for a specific account. Creates a new job and enqueues it in the sync queue.

```
POST /api/jobs/sync/:accountId
```

### Response

```json
{
  "job": {
    "id": "new-job-uuid",
    "connector": "gmail",
    "accountId": "account-uuid",
    "accountIdentifier": "user@gmail.com",
    "status": "queued",
    "priority": 0,
    "progress": 0,
    "total": 0,
    "startedAt": null,
    "completedAt": null,
    "error": null
  }
}
```

---

## Cancel Job

Cancel a running or queued job.

```
DELETE /api/jobs/:id
```

### Response

```json
{
  "ok": true
}
```

---

## Query Logs

Retrieve log entries for jobs, accounts, or specific log levels.

```
GET /api/logs
```

### Query Parameters

| Parameter | Type | Description |
|---|---|---|
| `jobId` | string | Filter by job ID |
| `accountId` | string | Filter by account ID |
| `level` | string | Filter by level: info, warn, error, debug |
| `limit` | number | Max entries (default: 100) |

### Response

```json
[
  {
    "id": "log-uuid",
    "jobId": "job-uuid",
    "connectorType": "gmail",
    "accountId": "account-uuid",
    "stage": "embed",
    "level": "info",
    "message": "[embed:done] a1b2c3d4 in 450ms -- db=5ms contacts=120ms(3) ollama=280ms(768d) qdrant=45ms",
    "timestamp": "2026-02-15T10:15:30Z"
  }
]
```

### Log Stages

| Stage | Description |
|---|---|
| `sync` | Connector sync operations |
| `embed` | Embedding and contact resolution |
| `file` | File download and content extraction |
| `enrich` | Entity extraction and factuality |
