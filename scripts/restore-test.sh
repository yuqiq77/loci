#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: scripts/restore-test.sh path/to/backup.dump" >&2
  exit 1
fi

dump_file=$1
restore_database=${RESTORE_DATABASE:-loci_restore}

if [ ! -f "$dump_file" ]; then
  echo "Backup file not found: $dump_file" >&2
  exit 1
fi

docker compose exec -T -e RESTORE_DATABASE="$restore_database" postgres sh -c \
  'if [ "$RESTORE_DATABASE" = "$POSTGRES_DB" ]; then
     echo "Refusing to replace the production database during a restore rehearsal" >&2
     exit 1
   fi'
docker compose exec -T -e RESTORE_DATABASE="$restore_database" postgres sh -c \
  'dropdb -U "$POSTGRES_USER" --if-exists "$RESTORE_DATABASE" &&
   createdb -U "$POSTGRES_USER" "$RESTORE_DATABASE"'
docker compose exec -T -e RESTORE_DATABASE="$restore_database" postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$RESTORE_DATABASE" --exit-on-error' \
  < "$dump_file"

docker compose exec -T -e RESTORE_DATABASE="$restore_database" postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$RESTORE_DATABASE" -Atc "
    select
      (select count(*) from sessions),
      (select count(*) from messages),
      (select count(*) from settings),
      (select count(*) from memories);
  "'
