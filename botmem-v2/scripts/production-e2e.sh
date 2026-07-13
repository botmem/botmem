#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
POSTGRES_IMAGE='pgvector/pgvector:0.8.2-pg17-bookworm@sha256:feb68f4f15446397d8cac7f4fe48fe4586de83160d1fc48b46283312d1a33966'
REDIS_IMAGE='redis:8.8.0-alpine@sha256:9d317178eceac8454a2284a9e6df2466b93c745529947f0cd42a0fa9609d7005'
RUN_ID="$(openssl rand -hex 6)"
DATABASE_HOST='127.0.0.1.nip.io'
POSTGRES_CONTAINER="botmem-v2-e2e-postgres-${RUN_ID}"
REDIS_CONTAINER="botmem-v2-e2e-redis-${RUN_ID}"
TEMP="$(mktemp -d "${TMPDIR:-/tmp}/botmem-v2-production-e2e.XXXXXX")"

cleanup() {
  docker rm -f "$POSTGRES_CONTAINER" "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$TEMP"
}
trap cleanup EXIT INT TERM

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 2 \
  -subj '/CN=Botmem Production E2E CA' \
  -keyout "$TEMP/ca.key" -out "$TEMP/ca.pem" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -sha256 -subj '/CN=localhost' \
  -keyout "$TEMP/server.key" -out "$TEMP/server.csr" >/dev/null 2>&1
cat > "$TEMP/server.ext" <<'EOF'
subjectAltName=DNS:localhost,DNS:127.0.0.1.nip.io,IP:127.0.0.1
extendedKeyUsage=serverAuth
EOF
openssl x509 -req -sha256 -days 2 -in "$TEMP/server.csr" \
  -CA "$TEMP/ca.pem" -CAkey "$TEMP/ca.key" -CAcreateserial \
  -out "$TEMP/server.pem" -extfile "$TEMP/server.ext" >/dev/null 2>&1
install -m 0600 "$TEMP/server.key" "$TEMP/redis-server.key"

# The pinned Redis image deliberately drops from root to its redis user
# (uid 999). Docker Desktop's bind-mount virtualization can make a runner-owned
# mode-0600 key appear readable, while a Linux runner correctly rejects it.
# Stage a dedicated ephemeral key for the real runtime uid and keep it
# owner-readable only; PostgreSQL retains the runner-owned original for its
# later docker-cp, and the containing directory remains non-listable to others.
chmod 0711 "$TEMP"
docker run --rm --user 0 \
  -v "$TEMP:/tls" \
  --entrypoint sh \
  "$REDIS_IMAGE" \
  -c 'chown redis:redis /tls/redis-server.key && chmod 0400 /tls/redis-server.key && chmod 0444 /tls/server.pem /tls/ca.pem'

docker run -d --name "$POSTGRES_CONTAINER" \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p 127.0.0.1::5432 \
  "$POSTGRES_IMAGE" >/dev/null
docker run -d --name "$REDIS_CONTAINER" \
  --user 0 \
  -v "$TEMP:/tls:ro" \
  -p 127.0.0.1::6379 \
  "$REDIS_IMAGE" redis-server \
    --port 0 \
    --tls-port 6379 \
    --tls-cert-file /tls/server.pem \
    --tls-key-file /tls/redis-server.key \
    --tls-ca-cert-file /tls/ca.pem \
    --tls-auth-clients no >/dev/null

POSTGRES_PORT="$(docker port "$POSTGRES_CONTAINER" 5432/tcp | awk -F: 'NR == 1 {print $NF}')"
REDIS_PORT="$(docker port "$REDIS_CONTAINER" 6379/tcp | awk -F: 'NR == 1 {print $NF}')"
ADMIN_CLUSTER_URL="postgresql://postgres@127.0.0.1:${POSTGRES_PORT}/postgres"
ADMIN_DATABASE_URL="postgresql://postgres@127.0.0.1:${POSTGRES_PORT}/botmem_v2_e2e"

for _attempt in $(seq 1 60); do
  if psql "$ADMIN_CLUSTER_URL" -Atc 'SELECT 1' 2>/dev/null | grep -qx 1; then
    break
  fi
  sleep 1
done
psql "$ADMIN_CLUSTER_URL" -v ON_ERROR_STOP=1 -Atc 'SELECT 1' | grep -qx 1

docker cp "$TEMP/server.pem" "$POSTGRES_CONTAINER:/var/lib/postgresql/data/server.crt"
docker cp "$TEMP/server.key" "$POSTGRES_CONTAINER:/var/lib/postgresql/data/server.key"
docker exec -u root "$POSTGRES_CONTAINER" \
  chown postgres:postgres /var/lib/postgresql/data/server.crt /var/lib/postgresql/data/server.key
docker exec -u root "$POSTGRES_CONTAINER" chmod 0600 /var/lib/postgresql/data/server.key
docker exec -u postgres "$POSTGRES_CONTAINER" psql -v ON_ERROR_STOP=1 \
  -c "ALTER SYSTEM SET ssl = 'on'" \
  -c "ALTER SYSTEM SET ssl_cert_file = '/var/lib/postgresql/data/server.crt'" \
  -c "ALTER SYSTEM SET ssl_key_file = '/var/lib/postgresql/data/server.key'" >/dev/null
docker restart "$POSTGRES_CONTAINER" >/dev/null
POSTGRES_PORT="$(docker port "$POSTGRES_CONTAINER" 5432/tcp | awk -F: 'NR == 1 {print $NF}')"
ADMIN_CLUSTER_URL="postgresql://postgres@127.0.0.1:${POSTGRES_PORT}/postgres"
ADMIN_DATABASE_URL="postgresql://postgres@127.0.0.1:${POSTGRES_PORT}/botmem_v2_e2e"
for _attempt in $(seq 1 60); do
  if psql "$ADMIN_CLUSTER_URL" -Atc 'SELECT 1' 2>/dev/null | grep -qx 1; then
    break
  fi
  sleep 1
done
if ! psql "$ADMIN_CLUSTER_URL" -v ON_ERROR_STOP=1 -Atc 'SHOW ssl' | grep -qx on; then
  docker logs "$POSTGRES_CONTAINER" >&2
  exit 1
fi

for _attempt in $(seq 1 60); do
  if docker exec "$REDIS_CONTAINER" redis-cli --tls --cacert /tls/ca.pem ping \
    2>/dev/null | grep -qx PONG; then
    break
  fi
  sleep 1
done
if ! docker exec "$REDIS_CONTAINER" redis-cli --tls --cacert /tls/ca.pem ping \
  | grep -qx PONG; then
  docker inspect --format '{{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}}' \
    "$REDIS_CONTAINER" >&2 || true
  docker logs "$REDIS_CONTAINER" >&2 || true
  exit 1
fi

psql "$ADMIN_CLUSTER_URL" -v ON_ERROR_STOP=1 -c 'CREATE DATABASE botmem_v2_e2e'
psql "$ADMIN_CLUSTER_URL" -v ON_ERROR_STOP=1 -f "$ROOT/db/bootstrap/00_roles.sql"
psql "$ADMIN_CLUSTER_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE botmem_e2e_migrator LOGIN NOINHERIT;
CREATE ROLE botmem_e2e_api LOGIN NOINHERIT;
CREATE ROLE botmem_e2e_worker LOGIN NOINHERIT;
CREATE ROLE botmem_e2e_dispatcher LOGIN NOINHERIT;
CREATE ROLE botmem_e2e_commerce LOGIN NOINHERIT;
CREATE ROLE botmem_e2e_identity LOGIN NOINHERIT;
CREATE ROLE botmem_e2e_lifecycle LOGIN NOINHERIT;
GRANT botmem_migrator TO botmem_e2e_migrator;
GRANT botmem_api TO botmem_e2e_api;
GRANT botmem_worker TO botmem_e2e_worker;
GRANT botmem_dispatcher TO botmem_e2e_dispatcher;
GRANT botmem_commerce TO botmem_e2e_commerce;
GRANT botmem_identity_admin TO botmem_e2e_identity;
GRANT botmem_lifecycle TO botmem_e2e_lifecycle;
SQL
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c 'GRANT CREATE ON DATABASE botmem_v2_e2e TO botmem_schema_owner' \
  -c 'CREATE EXTENSION vector'

MIGRATOR_DATABASE_URL="postgresql://botmem_e2e_migrator@127.0.0.1:${POSTGRES_PORT}/botmem_v2_e2e"
pnpm --dir "$ROOT" --filter @botmem-v2/migrator build >/dev/null
NODE_ENV=test \
MIGRATOR_EXPECTED_LOGIN=botmem_e2e_migrator \
MIGRATIONS_DIR="$ROOT/db/migration" \
DATABASE_URL="$MIGRATOR_DATABASE_URL" \
  node "$ROOT/apps/migrator/dist/bin.js" >/dev/null
while IFS= read -r invariant; do
  psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$invariant" >/dev/null
done < <(find "$ROOT/db/tests" -maxdepth 1 -type f -name 'V*.sql' -print | sort -V)

cd "$ROOT"
pnpm build
pnpm package:cli
CLI_ARTIFACT="$(find "$ROOT/artifacts/cli" -maxdepth 1 -type f -name '*.tgz' -print -quit)"
[[ -n "$CLI_ARTIFACT" ]] || { echo 'packaged CLI artifact is missing' >&2; exit 1; }
npm install --ignore-scripts --no-audit --no-fund \
  --prefix "$TEMP/cli-install" "$CLI_ARTIFACT" >/dev/null
cargo build --locked -p botmem-tunnel --bin botmem-tunnel
cargo build --locked -p botmem-device-core --example seed_production_e2e_index

export BOTMEM_V2_PRODUCTION_E2E=1
export BOTMEM_E2E_ADMIN_DATABASE_URL="postgresql://postgres@127.0.0.1:${POSTGRES_PORT}/botmem_v2_e2e?sslmode=require"
export BOTMEM_E2E_API_DATABASE_URL="postgresql://botmem_e2e_api@${DATABASE_HOST}:${POSTGRES_PORT}/botmem_v2_e2e?sslmode=verify-full"
export BOTMEM_E2E_WORKER_DATABASE_URL="postgresql://botmem_e2e_worker@${DATABASE_HOST}:${POSTGRES_PORT}/botmem_v2_e2e?sslmode=verify-full"
export BOTMEM_E2E_DISPATCHER_DATABASE_URL="postgresql://botmem_e2e_dispatcher@${DATABASE_HOST}:${POSTGRES_PORT}/botmem_v2_e2e?sslmode=verify-full"
export BOTMEM_E2E_COMMERCE_DATABASE_URL="postgresql://botmem_e2e_commerce@${DATABASE_HOST}:${POSTGRES_PORT}/botmem_v2_e2e?sslmode=verify-full"
export BOTMEM_E2E_IDENTITY_DATABASE_URL="postgresql://botmem_e2e_identity@${DATABASE_HOST}:${POSTGRES_PORT}/botmem_v2_e2e?sslmode=verify-full"
export BOTMEM_E2E_LIFECYCLE_DATABASE_URL="postgresql://botmem_e2e_lifecycle@${DATABASE_HOST}:${POSTGRES_PORT}/botmem_v2_e2e?sslmode=verify-full"
export BOTMEM_E2E_REDIS_URL="rediss://127.0.0.1:${REDIS_PORT}"
export BOTMEM_E2E_TLS_CERT_PATH="$TEMP/server.pem"
export BOTMEM_E2E_TLS_KEY_PATH="$TEMP/server.key"
export BOTMEM_E2E_TLS_CA_PATH="$TEMP/ca.pem"
export NODE_EXTRA_CA_CERTS="$TEMP/ca.pem"
export BOTMEM_TUNNEL_TEST_BINARY="$ROOT/target/debug/botmem-tunnel"
export BOTMEM_PRODUCTION_E2E_SEED_BINARY="$ROOT/target/debug/examples/seed_production_e2e_index"
export BOTMEM_PRODUCTION_E2E_CLI_BINARY="$TEMP/cli-install/node_modules/.bin/botmem"

pnpm --filter @botmem-v2/testkit test -- src/production-composition.integration.test.ts
