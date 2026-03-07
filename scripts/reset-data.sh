#!/usr/bin/env bash
# Reset all botmem data except connector accounts/credentials.
# Also removes whatsapp accounts and session files if present.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DB="$ROOT/apps/api/data/botmem.db"
WA_SESSIONS="$ROOT/apps/api/data/whatsapp"

echo "==> Flushing Redis (BullMQ queues)..."
npx -y redis-cli FLUSHALL 2>/dev/null || echo "    (redis-cli not available, skipping)"

echo "==> Deleting Qdrant collection (memories)..."
curl -s -X DELETE http://localhost:6333/collections/memories > /dev/null 2>&1 || echo "    (Qdrant not reachable, skipping)"

echo "==> Clearing SQLite data (keeping accounts & credentials)..."
sqlite3 "$DB" <<'SQL'
DELETE FROM memory_contacts;
DELETE FROM memory_links;
DELETE FROM memories;
DELETE FROM raw_events;
DELETE FROM contact_identifiers;
DELETE FROM merge_dismissals;
DELETE FROM contacts;
DELETE FROM logs;
DELETE FROM jobs;
SQL

echo "==> Resetting account sync cursors..."
sqlite3 "$DB" "UPDATE accounts SET last_cursor = NULL, items_synced = 0, last_sync_at = NULL, last_error = NULL;"

echo "==> Removing whatsapp accounts..."
sqlite3 "$DB" "DELETE FROM accounts WHERE connector_type = 'whatsapp';"

echo "==> Removing whatsapp session files..."
if [ -d "$WA_SESSIONS" ]; then
  rm -rf "$WA_SESSIONS"/wa-session-*
  echo "    Removed session files"
else
  echo "    No session directory found"
fi

# Flush Redis again at the end — if the API was running during reset,
# it may have re-queued BullMQ jobs from the (now-cleared) SQLite state.
echo "==> Final Redis flush (clear any re-queued jobs)..."
npx -y redis-cli FLUSHALL 2>/dev/null || echo "    (redis-cli not available, skipping)"

echo "==> Done. Restart the server to pick up changes."
