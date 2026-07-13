#!/bin/bash
set -euo pipefail

install -d -m 0700 -o postgres -g postgres /var/lib/postgresql/tls
install -m 0644 -o postgres -g postgres /run/secrets/internal_ca_crt /var/lib/postgresql/tls/ca.crt
install -m 0644 -o postgres -g postgres /run/secrets/postgres_server_crt /var/lib/postgresql/tls/server.crt
install -m 0600 -o postgres -g postgres /run/secrets/postgres_server_key /var/lib/postgresql/tls/server.key

exec /usr/local/bin/docker-entrypoint.sh postgres \
  -c ssl=on \
  -c ssl_ca_file=/var/lib/postgresql/tls/ca.crt \
  -c ssl_cert_file=/var/lib/postgresql/tls/server.crt \
  -c ssl_key_file=/var/lib/postgresql/tls/server.key \
  -c hba_file=/opt/botmem/pg_hba.conf \
  -c password_encryption=scram-sha-256 \
  -c shared_buffers=192MB \
  -c max_connections=80 \
  -c log_statement=none \
  -c log_min_duration_statement=1000
