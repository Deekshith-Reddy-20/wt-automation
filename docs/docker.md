# Running with Docker

The repo ships a multi-stage `Dockerfile` (Next.js standalone output,
runs as a non-root user) and a `docker-compose.yml` with the `app`,
a `scheduler` for the every-minute jobs, and an optional `caddy`
HTTPS proxy (`--profile https`). Supabase is external — point the app at your hosted
(or self-hosted) Supabase project via env vars; no database container
is included.

## Quick start

1. Copy the env template and fill it in:

   ```bash
   cp .env.local.example .env.local
   ```

2. Build and start (the `--env-file` flag is required — Compose only
   reads `.env` by default for `${VAR}` substitution, and this project
   keeps its config in `.env.local`):

   ```bash
   docker compose --env-file .env.local up --build -d
   ```

3. The app is served on [http://localhost:3000](http://localhost:3000)
   (publish it elsewhere with `HOST_PORT=8080` in `.env.local`).

> Use `HOST_PORT`, not `PORT`, to move the published port. `PORT` is
> what the server listens on _inside_ the container, and `env_file`
> would inject it there — leaving the app on a port the mapping and
> the healthcheck don't target. Compose pins it to 3000 for that
> reason.

## Build-time vs runtime variables

- `NEXT_PUBLIC_*` variables are **inlined into the client bundle at
  build time**. They are passed as Docker build args by
  `docker-compose.yml`. If you change any of them, rebuild:
  `docker compose --env-file .env.local up --build -d`.
- Everything else (`SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`,
  `META_APP_SECRET`, …) is read at **runtime** from `.env.local` via
  `env_file` and is never baked into the image — safe to change with
  just a container restart.

## Plain Docker (no Compose)

```bash
docker build \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key \
  -t vfarms-app .

docker run -d --env-file .env.local -e PORT=3000 -p 3000:3000 vfarms-app
```

## Notes

- Database migrations under `supabase/` are **not** run by the
  container — apply them with the Supabase CLI as described in the
  README.
- Received attachments are copied into the `chat-media` Supabase
  Storage bucket, because Meta deletes media roughly 30 days after it
  arrives and the copy is the only thing that outlives that. It grows
  with inbound volume, so it's worth watching your project's storage
  quota. Turn it off per account under Settings → WhatsApp →
  Attachment Storage; attachments received while it's off become
  unviewable once Meta drops them. Files over 16 MB (the bucket's
  limit) are never copied.
- The `scheduler` service calls `/api/resort/cron`,
  `/api/automations/cron`, `/api/flows/cron` and
  `/api/whatsapp/webhook/sweep` every minute with the
  `AUTOMATION_CRON_SECRET` header. Without that variable the jobs
  return 503 and guest reminders, hold expiry and MSG91 delivery
  status never run. `docker compose logs scheduler` prints only
  failed calls.

## Deploying to a server (VPS)

Any Linux server with Docker works (Hostinger VPS, DigitalOcean,
AWS Lightsail, …).

1. Install Docker: `curl -fsSL https://get.docker.com | sh`.
2. Point your domain's DNS **A record** at the server's IP and open
   ports 80 and 443 in the server firewall.
3. Copy the project to the server (`git clone`, or `scp` the folder
   without `node_modules` / `.next`), then create `.env.local` with
   the production values. On top of the local ones set:

   ```bash
   NEXT_PUBLIC_SITE_URL=https://crm.vfarms.in
   DOMAIN=crm.vfarms.in
   HOST_BIND=127.0.0.1
   AUTOMATION_CRON_SECRET=<openssl rand -hex 32>
   ```

4. Build and start the app, scheduler and Caddy (HTTPS with an
   automatic Let's Encrypt certificate):

   ```bash
   docker compose --env-file .env.local --profile https up --build -d
   docker compose ps          # app should be "healthy"
   ```

5. In MSG91 → WhatsApp → Webhook (New) → **On Inbound Request
   Received**, set `https://<DOMAIN>/api/msg91/webhook` (POST, JSON).
   Once that is live, stop any local ngrok tunnel so MSG91 has a
   single destination.

Update after code changes: `git pull && docker compose --env-file
.env.local --profile https up --build -d`. Logs: `docker compose logs
-f app`.

If the host already runs its own web server / panel proxy (Nginx,
Traefik, Coolify, Hostinger's Docker manager), skip `--profile https`
and proxy your domain to port 3000 instead.
