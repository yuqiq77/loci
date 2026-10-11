#!/bin/sh
set -eu

backup_dir=${BACKUP_DIR:-backups}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
output="$backup_dir/loci-$timestamp.dump"
temporary="$output.tmp"

mkdir -p "$backup_dir"
trap 'rm -f "$temporary"' EXIT
docker compose exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$temporary"
mv "$temporary" "$output"
trap - EXIT

printf '%s\n' "$output"
