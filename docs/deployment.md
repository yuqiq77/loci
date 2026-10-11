# Loci Deployment

This is the reference single-server deployment. Docker Compose runs
PostgreSQL, the one-shot migration service, Loci, and Caddy. Only Caddy
publishes host ports.

## Prerequisites

- A Linux server with public TCP ports 80 and 443
- A DNS `A` or `AAAA` record pointing the chosen hostname to the server
- Docker Engine with the Compose plugin
- A clone of this repository

## First Deployment

1. Copy the environment template:

   ```bash
   cp .env.example .env
   chmod 600 .env
   ```

2. Set `DOMAIN` and `APP_ORIGIN` to the real HTTPS hostname. Set a URL-safe
   `POSTGRES_PASSWORD` and use the same value in `DATABASE_URL`.

3. Generate application secrets:

   ```bash
   openssl rand -base64 32
   read -s OWNER_PASSWORD
   echo
   export OWNER_PASSWORD
   npm ci
   npm run auth:hash-password
   unset OWNER_PASSWORD
   ```

   Put the random value in `SESSION_SECRET` and the generated Argon2id hash in
   `OWNER_PASSWORD_HASH`. The hash command escapes `$` characters for dotenv
   files. Paste its output inside double quotes, keeping every backslash:
   `OWNER_PASSWORD_HASH="<escaped output>"`. Compose requires the quotes to
   preserve the hash; Next.js accepts the same form. Add the required `CHAT_*`
   values. Compression and embedding configuration remain optional.

4. Validate the Compose configuration without printing resolved secrets:

   ```bash
   docker compose config --quiet
   ```

5. Build and start the stack:

   ```bash
   docker compose up --build -d
   docker compose ps
   ```

   Startup order is PostgreSQL healthy, migration complete, app healthy, then
   Caddy. The app image runs as a non-root user. PostgreSQL and the app expose
   no host ports; only Caddy publishes 80 and 443.

6. Verify:

   ```bash
   curl --fail --silent --show-error "https://$DOMAIN/api/health"
   docker compose logs --tail=100 migrate app caddy
   ```

   Then sign in at `https://$DOMAIN`. `/api/health` is intentionally public and
   returns no credentials or application data. Every other application route
   remains protected by owner authentication.

## Local Development

The production Compose file does not publish PostgreSQL. Use the development
override when running Next.js on the host:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres
DATABASE_URL=postgresql://loci:loci@127.0.0.1:5433/loci npm run db:migrate
npm run dev
```

The override publishes PostgreSQL on `127.0.0.1:5433`. Use matching local
values for `POSTGRES_PASSWORD` and `DATABASE_URL`; a host-side `DATABASE_URL`
belongs in `.env.local`, which Next.js and `db:migrate` read and Compose does
not. Nothing outside Compose runs the migrations: run `npm run db:migrate`
again after pulling new ones.

## Upgrade

Back up the database before every upgrade, then:

```bash
git pull --ff-only
docker compose build
docker compose rm -f migrate
docker compose up -d
docker compose ps
curl --fail --silent --show-error "https://$DOMAIN/api/health"
```

Removing the completed one-shot container makes Compose rerun the checked-in
migration service before replacing the app.
Never run multiple app containers for v0.1.0; the deployment is designed for a
single long-lived application process.

## Security Checks

- Keep `.env` mode `0600` and never commit it.
- Keep PostgreSQL and app services without host `ports`.
- Allow inbound 22, 80, and 443 only, restricting SSH where practical.
- Confirm `.dockerignore` excludes `.env`, `.env.*`, backups, Git data, test
  output, and local dependencies.
- Copy encrypted backups off the server and rehearse restores regularly.
