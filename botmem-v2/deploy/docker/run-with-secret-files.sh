#!/bin/sh
set -eu

# Docker Compose mounts production secrets as files. The image receives only
# *_FILE paths in its inspectable container configuration; this wrapper loads
# their contents into the child process without printing them.
file_variables=$(env | sed -n 's/^\([A-Z][A-Z0-9_]*_FILE\)=.*/\1/p')
for file_variable in $file_variables; do
  base_variable=${file_variable%_FILE}
  file_path=$(printenv "$file_variable")

  if [ -n "$(printenv "$base_variable" 2>/dev/null || true)" ]; then
    echo "botmem secret loader: both ${base_variable} and ${file_variable} are set" >&2
    exit 78
  fi
  if [ -z "$file_path" ] || [ ! -f "$file_path" ] || [ ! -r "$file_path" ]; then
    echo "botmem secret loader: ${file_variable} is not a readable regular file" >&2
    exit 78
  fi

  byte_count=$(wc -c < "$file_path" | tr -d '[:space:]')
  if [ "$byte_count" -lt 1 ] || [ "$byte_count" -gt 65536 ]; then
    echo "botmem secret loader: ${file_variable} has an invalid size" >&2
    exit 78
  fi

  secret_value=$(cat "$file_path")
  export "$base_variable=$secret_value"
  unset "$file_variable"
done

exec "$@"
