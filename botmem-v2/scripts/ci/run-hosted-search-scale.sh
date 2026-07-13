#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${BOTMEM_SCALE_DESTRUCTIVE_CONFIRM:?destructive confirmation is required}"
: "${BOTMEM_BENCH_CLUSTER_ADMIN_DATABASE_URL:?cluster administrator URL is required}"
: "${BOTMEM_BENCH_ADMIN_DATABASE_URL:?benchmark administrator URL is required}"
: "${BOTMEM_BENCH_MIGRATOR_DATABASE_URL:?benchmark migrator URL is required}"
: "${BOTMEM_BENCH_API_DATABASE_URL:?benchmark API URL is required}"
[[ "$BOTMEM_SCALE_DESTRUCTIVE_CONFIRM" == botmem_v2_bench ]] \
  || { echo 'hosted scale: confirmation must equal botmem_v2_bench' >&2; exit 78; }
for url in "$BOTMEM_BENCH_ADMIN_DATABASE_URL" "$BOTMEM_BENCH_MIGRATOR_DATABASE_URL" \
  "$BOTMEM_BENCH_API_DATABASE_URL"; do
  [[ "$url" == */botmem_v2_bench ]] \
    || { echo 'hosted scale: every benchmark URL must target botmem_v2_bench' >&2; exit 78; }
done

psql "$BOTMEM_BENCH_CLUSTER_ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE IF EXISTS botmem_v2_bench' \
  -c 'CREATE DATABASE botmem_v2_bench'
psql "$BOTMEM_BENCH_CLUSTER_ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f "$root/db/bootstrap/00_roles.sql" >/dev/null
psql "$BOTMEM_BENCH_CLUSTER_ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $logins$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'botmem_bench_migrator') THEN
    CREATE ROLE botmem_bench_migrator LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'botmem_bench_api') THEN
    CREATE ROLE botmem_bench_api LOGIN NOINHERIT;
  END IF;
END
$logins$;
GRANT botmem_migrator TO botmem_bench_migrator;
GRANT botmem_api TO botmem_bench_api;
SQL
psql "$BOTMEM_BENCH_ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c 'GRANT CREATE ON DATABASE botmem_v2_bench TO botmem_schema_owner' \
  -c 'CREATE EXTENSION vector'

pnpm --dir "$root" --filter @botmem-v2/migrator build >/dev/null
NODE_ENV=test \
MIGRATOR_EXPECTED_LOGIN=botmem_bench_migrator \
MIGRATIONS_DIR="$root/db/migration" \
DATABASE_URL="$BOTMEM_BENCH_MIGRATOR_DATABASE_URL" \
  node "$root/apps/migrator/dist/bin.js" >/dev/null

BOTMEM_RUN_SCALE_BENCHMARK=1 \
BOTMEM_BENCH_ADMIN_DATABASE_URL="$BOTMEM_BENCH_ADMIN_DATABASE_URL" \
BOTMEM_BENCH_API_DATABASE_URL="$BOTMEM_BENCH_API_DATABASE_URL" \
  pnpm --filter @botmem-v2/api test -- --run src/search/hosted-search.scale.test.ts
