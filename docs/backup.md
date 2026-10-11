# Loci Backup and Restore

PostgreSQL dumps are the authoritative Loci backup. Version 0.1.0 uses a
host cron job rather than an application scheduler.

## Create a Backup

With the Compose stack running:

```bash
chmod +x scripts/backup.sh scripts/restore-test.sh
BACKUP_DIR=/srv/loci-backups ./scripts/backup.sh
```

The script writes an atomic, compressed custom-format dump named
`loci-YYYYMMDDTHHMMSSZ.dump`. Verify it before copying it off-host:

```bash
docker compose exec -T postgres sh -c \
  'pg_restore --list' < /srv/loci-backups/loci-TIMESTAMP.dump \
  >/dev/null
```

## Nightly Cron

Example root crontab entry:

```cron
15 2 * * * cd /opt/loci && BACKUP_DIR=/srv/loci-backups ./scripts/backup.sh >> /var/log/loci-backup.log 2>&1
```

Retain at least seven daily backups and four weekly backups. Copy backups to a
different host or object store. Encrypt before transfer, for example:

```bash
age -r AGE_PUBLIC_KEY loci-TIMESTAMP.dump \
  > loci-TIMESTAMP.dump.age
rsync -a loci-TIMESTAMP.dump.age backup-host:/srv/loci/
```

Keep the age private key outside the application server. A local-only dump is
not sufficient disaster recovery.

## Restore Rehearsal

Restore every backup into a separate clean database before treating it as
usable:

```bash
RESTORE_DATABASE=loci_restore \
  ./scripts/restore-test.sh /srv/loci-backups/loci-TIMESTAMP.dump
```

The script drops and recreates only the named rehearsal database, restores
with `--exit-on-error`, then prints counts in this order:

```text
sessions|messages|settings|memories
```

The restored database must contain exactly one settings row and the expected
session, message, and active or soft-deleted memory records.
The script refuses to run when `RESTORE_DATABASE` equals the live
`POSTGRES_DB`.

Additional verification:

```bash
docker compose exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d loci_restore -c "\dt"'
docker compose exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d loci_restore -c "\dx"'
```

## Production Recovery

1. Stop traffic and application writes:

   ```bash
   docker compose stop caddy app
   ```

2. Keep the original PostgreSQL volume until the rehearsal restore and count
   checks pass.
3. Restore the verified dump into a new database or new PostgreSQL volume.
4. Point `DATABASE_URL` at the restored database.
5. Start migrations and the application:

   ```bash
   docker compose rm -f migrate
   docker compose up -d
   docker compose ps
   ```

6. Verify health, owner login, sessions, messages, settings, and memories
   before removing the old database or backup.

Target recovery objectives for v0.1.0 are a 24-hour RPO and four-hour RTO.
