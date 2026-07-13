#!/bin/bash
set -euo pipefail

umask 077

config_env="${1:?config env is required}"
release_env="${2:?release env is required}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
secrets_dir="$(sed -n 's/^BOTMEM_V2_SECRETS_DIR=//p' "$config_env")"
[[ -n "$secrets_dir" ]] || { echo 'backup: BOTMEM_V2_SECRETS_DIR is missing' >&2; exit 78; }
recipient_file="$secrets_dir/backup-age-recipient"
identity_file="$secrets_dir/backup-age-identity"
[[ -s "$recipient_file" && -s "$identity_file" ]] \
  || { echo 'backup: age recipient and identity files are required' >&2; exit 78; }
recipient="$(<"$recipient_file")"
[[ "$recipient" =~ ^age1[0-9a-z]+$ ]] || { echo 'backup: age recipient is invalid' >&2; exit 78; }

backup_root="${BOTMEM_V2_BACKUP_DIR:-/opt/botmem-v2/backups}"
mkdir -p "$backup_root"
chmod 0700 "$backup_root"
exec 9>"$backup_root/.backup.lock"
flock -n 9 || { echo 'backup: another backup or restore rehearsal is active' >&2; exit 75; }
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$backup_root/botmem-v2-$stamp.dump.age"
work="$(mktemp -d "$backup_root/.verify.XXXXXX")"
restore_name="botmem-v2-restore-$RANDOM-$$"
restore_volume="$restore_name-data"
verified=false
password_file="$work/postgres-password"
metadata_dir="$work/restore-metadata"
mkdir -m 0700 "$metadata_dir"
printf '%s\n' "$(openssl rand -base64 36 | tr -d '\n=+/')" > "$password_file"
chmod 0600 "$password_file"
cleanup() {
  docker rm -f "$restore_name" >/dev/null 2>&1 || true
  docker volume rm -f "$restore_volume" >/dev/null 2>&1 || true
  rm -rf "$work"
  if [[ "$verified" != true ]]; then rm -f "$archive" "$archive.sha256"; fi
}
trap cleanup EXIT

compose=(docker compose --project-name botmem-v2 --env-file "$config_env" --env-file "$release_env" -f "$root/compose.yaml")
"${compose[@]}" exec -T postgres pg_dump -U postgres -d botmem_v2 \
  --format=custom --compress=9 --no-owner \
  | age --encrypt --recipient "$recipient" --output "$archive"
chmod 0600 "$archive"
[[ -s "$archive" ]] || { echo 'backup: encrypted archive is empty' >&2; exit 1; }

postgres_image="$(sed -n 's/^BOTMEM_V2_DATABASE_IMAGE=//p' "$release_env")"
[[ "$postgres_image" =~ ^[a-z0-9][a-z0-9._:/-]*/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] \
  || { echo 'backup: release database image must be an immutable digest' >&2; exit 78; }
docker volume create "$restore_volume" >/dev/null
docker run -d --name "$restore_name" --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev \
  --tmpfs /run/postgresql:rw,nosuid,nodev \
  -e POSTGRES_DB=botmem_v2_restore_verify -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password \
  -v "$password_file:/run/secrets/postgres-password:ro" \
  -v "$metadata_dir:/restore-metadata:ro" \
  -v "$restore_volume:/var/lib/postgresql/data" \
  "$postgres_image" >/dev/null
for _ in {1..60}; do
  docker exec "$restore_name" pg_isready -U postgres -d botmem_v2_restore_verify >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$restore_name" pg_isready -U postgres -d botmem_v2_restore_verify >/dev/null
docker exec -i "$restore_name" psql -U postgres -d botmem_v2_restore_verify \
  -X -v ON_ERROR_STOP=1 < "$root/../../db/bootstrap/00_roles.sql" >/dev/null
docker exec "$restore_name" psql -U postgres -d botmem_v2_restore_verify -X -v ON_ERROR_STOP=1 \
  -c 'CREATE EXTENSION IF NOT EXISTS vector' \
  -c 'GRANT CREATE ON DATABASE botmem_v2_restore_verify TO botmem_schema_owner' >/dev/null
age --decrypt --identity "$identity_file" "$archive" \
  | docker exec -i "$restore_name" pg_restore --list > "$metadata_dir/restore.list"
[[ "$(grep -Ec ' (EXTENSION - vector|COMMENT - EXTENSION vector)[[:space:]]*$' "$metadata_dir/restore.list")" == 2 ]] \
  || { echo 'backup: dump did not contain the expected vector extension entries' >&2; exit 1; }
grep -Ev ' (EXTENSION - vector|COMMENT - EXTENSION vector)[[:space:]]*$' \
  "$metadata_dir/restore.list" > "$metadata_dir/restore.filtered.list"
age --decrypt --identity "$identity_file" "$archive" \
  | docker exec -i "$restore_name" pg_restore -U postgres -d botmem_v2_restore_verify \
      --exit-on-error --no-owner --role=botmem_schema_owner \
      --use-list=/restore-metadata/restore.filtered.list

count_sql=$'SELECT format(\'SELECT %L || \'\'|\'\' || count(*) FROM %I.%I;\', schemaname || \'.\' || tablename, schemaname, tablename) FROM pg_tables WHERE schemaname=\'botmem\' ORDER BY tablename;\n\\gexec\n'
printf '%s' "$count_sql" \
  | "${compose[@]}" exec -T postgres psql -U postgres -d botmem_v2 -X -At \
  | LC_ALL=C sort > "$work/source-counts"
printf '%s' "$count_sql" \
  | docker exec -i "$restore_name" psql -U postgres -d botmem_v2_restore_verify -X -At \
  | LC_ALL=C sort > "$work/restore-counts"
diff -u "$work/source-counts" "$work/restore-counts"

if [[ -s "$work/source-counts" ]]; then
  while IFS= read -r invariant; do
    docker exec -i "$restore_name" psql -U postgres -d botmem_v2_restore_verify \
      -X -v ON_ERROR_STOP=1 < "$invariant" >/dev/null
  done < <(printf '%s\n' "$root"/../../db/tests/V*.sql | sort -V)
fi
docker exec "$restore_name" psql -U postgres -d botmem_v2_restore_verify -X -Atc \
  "SELECT current_database() = 'botmem_v2_restore_verify' AND NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname='botmem_api'" \
  | grep -qx t

digest="$(sha256sum "$archive" | awk '{print $1}')"
printf '%s  %s\n' "$digest" "$(basename "$archive")" > "$archive.sha256"
chmod 0600 "$archive.sha256"
ln -sfn "$(basename "$archive")" "$backup_root/latest.dump.age"
ln -sfn "$(basename "$archive").sha256" "$backup_root/latest.dump.age.sha256"
find "$backup_root" -type f -name 'botmem-v2-*.dump.age*' -mtime +30 -delete
verified=true
echo "backup: encrypted archive and disposable restore verified ($stamp, sha256:$digest)"
