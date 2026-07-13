#!/bin/sh
set -eu

password=$(cat /run/secrets/redis_password)
case "$password" in
  *[!A-Za-z0-9_-]*|'') echo 'redis password must be nonempty base64url' >&2; exit 78 ;;
esac

install -d -m 0700 -o redis -g redis /data/tls
install -m 0644 -o redis -g redis /run/secrets/internal_ca_crt /data/tls/ca.crt
install -m 0644 -o redis -g redis /run/secrets/redis_server_crt /data/tls/server.crt
install -m 0600 -o redis -g redis /run/secrets/redis_server_key /data/tls/server.key

cat > /data/redis-runtime.conf <<EOF
port 0
tls-port 6379
tls-cert-file /data/tls/server.crt
tls-key-file /data/tls/server.key
tls-ca-cert-file /data/tls/ca.crt
tls-auth-clients no
protected-mode yes
appendonly yes
appendfsync everysec
save 900 1
save 300 10
requirepass $password
maxmemory 160mb
maxmemory-policy noeviction
EOF
chown redis:redis /data/redis-runtime.conf
chmod 0600 /data/redis-runtime.conf

exec /usr/local/bin/docker-entrypoint.sh redis-server /data/redis-runtime.conf
