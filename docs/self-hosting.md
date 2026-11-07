# Self-hosting Open CRM

Open CRM is **one container plus Postgres**. Anything that can run a Docker image and give it a `DATABASE_URL` can run it. Pick the option that fits you:

| Option | Effort | Good for |
|---|---|---|
| [Docker Compose on any server](#docker-compose-any-server) | 2 commands | A VPS, a home server, a NAS, your laptop |
| [Render](#render) | One click | A managed host with a free or cheap database |
| [Railway](#railway) | A few clicks | A managed host with a usage-based price |
| [DigitalOcean App Platform](#digitalocean-app-platform) | One click | DigitalOcean users |
| [Heroku](#heroku) | One click | Heroku users |
| [Fly.io](#flyio) | CLI, ~5 commands | Edge regions, scale to zero |
| [Coolify, Dokploy, CapRover, Portainer](#coolify-dokploy-caprover-portainer) | Paste the compose file | Your own PaaS |
| [Kubernetes and anything else](#anything-else) | Your usual workflow | Existing clusters |

> Links below point at `housewithbricks/open-crm`. If you deploy from a fork, use your own repo instead.

---

## What the container needs

| Variable | Required | What it does |
|---|---|---|
| `DATABASE_URL` | yes* | Postgres connection string, e.g. `postgres://user:pass@host:5432/db`. Percent-encode special characters in the password (`/` → `%2F`, `@` → `%40`). Postgres 14+ works; 17 is used in development. *Or leave it unset and set `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and `PGDATABASE`, which take any password as written (the docker compose files do this). |
| `ADMIN_PASSWORD` | recommended | Password for the web UI. If unset, the app generates one on first boot and **prints it to the logs** once. Placeholder values like `change-me` are rejected in production. |
| `PORT` | no | Port to listen on (default `8080`). Most platforms set it for you. |
| `PUBLIC_URL` | no | Your public base URL (e.g. `https://crm.example.com`). Used to show the right MCP URL in the UI. |
| `SESSION_SECRET` | no | Signs login sessions. Generated and stored in the database if unset. |
| `DATABASE_SSL` | no | `require`, `prefer`, `verify-full` or `disable`. Only needed when your database needs TLS but its URL has no `?sslmode=` (Heroku). |
| `DATABASE_POOL_SIZE` | no | Max Postgres connections (default `10`). |
| `TRUSTED_PROXY_HOPS` | no | How many reverse proxies in front of the app add to `X-Forwarded-For` (default `1`: Caddy, Railway, Render, Heroku…). The sign-in limiter takes the client address that many entries from the right, so a forged header can't dodge it. Use `2` behind two proxies (e.g. Cloudflare + Caddy) and `0` when nothing is in front (then all clients share one limit). |
| `CLIENT_IP_HEADER` | no | A header your platform sets to the real client address, e.g. `fly-client-ip` or `cf-connecting-ip`. Wins over `X-Forwarded-For`. |
| `LOGIN_GLOBAL_MAX` | no | Failed sign-ins from all addresses together, within 15 minutes, before sign-in pauses for 5 minutes (default `100`). One address is paused after 10. |
| `WEBHOOK_ALLOW_PRIVATE` | no | Set to `1` to allow webhooks to link-local and cloud metadata addresses (`169.254.0.0/16`, `fe80::/10`), which are refused by default. Localhost and private networks are always allowed. |

The container:
- listens on `$PORT` and serves the web UI at `/`, the REST API at `/api`, MCP at `/mcp` and a health check at `/health`;
- **runs database migrations on start**, so upgrades are just "pull the new image and restart";
- runs as a non-root user and keeps no state on disk. Everything lives in Postgres.

---

## Docker Compose (any server)

On any machine with Docker:

```bash
git clone https://github.com/housewithbricks/open-crm.git && cd open-crm
cp .env.example .env            # set ADMIN_PASSWORD (and POSTGRES_PASSWORD)
docker compose up -d            # → http://localhost:8080
```

**Without cloning** (uses the prebuilt image from GitHub Container Registry):

```bash
mkdir open-crm && cd open-crm
curl -fsSLO https://raw.githubusercontent.com/housewithbricks/open-crm/main/deploy/docker-compose.yml
echo "ADMIN_PASSWORD=$(openssl rand -base64 18)" > .env && cat .env
docker compose up -d
```

**HTTPS on your own domain.** Point your domain's DNS (an `A` record) at the server, then:

```bash
echo "DOMAIN=crm.example.com" >> .env
echo "PUBLIC_URL=https://crm.example.com" >> .env
docker compose --profile https up -d
```

This adds [Caddy](https://caddyserver.com), which gets and renews a Let's Encrypt certificate on its own. Ports 80 and 443 must be reachable. (With the no-clone setup, also `curl -fsSLO …/deploy/Caddyfile` into the same folder.)

**Reaching it from other machines over plain HTTP.** Both compose files publish port 8080 on `127.0.0.1` only, so with the `https` profile the app is reachable only through Caddy. To open `http://<server-ip>:8080` to your LAN instead, add `BIND_ADDRESS=0.0.0.0` to `.env`. Anyone who can reach that port sees the sign-in page over unencrypted HTTP, so don't do this on a server with a public IP.

**Landing page.** `docker compose --profile site up -d` also serves the static landing page from `site/` on port 8081. You don't need it to run the CRM.

### Backups

All your data is in Postgres. A nightly dump is enough for most people:

```bash
docker compose exec -T db pg_dump -U opencrm --clean --if-exists opencrm | gzip > backup-$(date +%F).sql.gz
```

`--clean --if-exists` makes the dump drop each table before recreating it, so it restores cleanly over a database the app has already set up.

To restore, start only the database (on a new server, don't start the app first: it would create and seed its own tables), restore in one transaction that stops at the first error, then start the app:

```bash
docker compose stop app                       # on a new server: docker compose up -d db
gunzip -c backup-2026-11-06.sql.gz | docker compose exec -T db \
  psql -U opencrm -d opencrm -v ON_ERROR_STOP=1 --single-transaction
docker compose up -d
```

If anything fails, nothing is changed. A dump made without `--clean` only restores into an empty database: on a new server, run `docker compose up -d db` (not the whole stack) before restoring it.

You can also export any object as CSV from the UI (Export button) or through the REST API.

### Upgrades

```bash
git pull && docker compose up -d --build     # from source
docker compose pull && docker compose up -d  # prebuilt image
```

Migrations run automatically on start. Take a backup first.

---

## Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/housewithbricks/open-crm)

The button reads [`render.yaml`](../render.yaml). It creates a web service from the `Dockerfile` and a Postgres database, and wires `DATABASE_URL` for you. You'll be asked for `ADMIN_PASSWORD`. Pick instance and database plans in the Render dashboard (free database instances expire, so use a paid one for real data).

---

## Railway

1. **New Project → Deploy from GitHub repo** and pick your repo. Railway builds the `Dockerfile` (see [`railway.json`](../railway.json)).
2. **+ New → Database → PostgreSQL** in the same project.
3. On the app service, set these variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `ADMIN_PASSWORD` = a strong password
   - `PUBLIC_URL` = your Railway domain (next step)
4. **Settings → Networking → Generate Domain.**

**One-click button for your fork.** In Railway, open the project and choose **Settings → Create template** (or publish it from the Templates page). Railway gives you a URL like `https://railway.com/deploy/abc123`. Use it in a button:

```md
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/abc123)
```

---

## DigitalOcean App Platform

[![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/housewithbricks/open-crm/tree/main)

The button reads [`.do/deploy.template.yaml`](../.do/deploy.template.yaml). It creates the web service and a dev Postgres database. No password is preset: open **Runtime Logs** after the first deploy to find the generated admin password, or add `ADMIN_PASSWORD` as an encrypted env var before deploying. For real data, swap the dev database for a managed one.

---

## Heroku

[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/housewithbricks/open-crm)

The button reads [`app.json`](../app.json) and [`heroku.yml`](../heroku.yml). It builds the container, adds Heroku Postgres and sets `DATABASE_SSL=require` (Heroku's URLs don't include `sslmode`). You'll be asked for `ADMIN_PASSWORD`.

---

## Fly.io

Fly needs its CLI ([install `flyctl`](https://fly.io/docs/flyctl/install/)). [`fly.toml`](../fly.toml) is included.

```bash
fly launch --copy-config --no-deploy            # pick an app name and region
fly postgres create --name open-crm-db          # or Fly Managed Postgres, or any Postgres you have
fly postgres attach open-crm-db                 # sets DATABASE_URL as a secret
fly secrets set ADMIN_PASSWORD="$(openssl rand -base64 18)" PUBLIC_URL="https://<app>.fly.dev"
fly deploy
```

`fly.toml` lets the app scale to zero when idle. The first request after a pause takes a second or two while it wakes up. If you'd rather keep it warm, set `min_machines_running = 1`.

---

## Coolify, Dokploy, CapRover, Portainer

These platforms deploy a Docker Compose file. Use [`deploy/docker-compose.yml`](../deploy/docker-compose.yml) (prebuilt image) or the root [`docker-compose.yml`](../docker-compose.yml) (builds from the Git repo):

- **Coolify:** New Resource → Docker Compose → paste the file (or point it at the repo). Set `ADMIN_PASSWORD` in Environment Variables, and assign a domain to the `app` service on port 8080. Coolify handles HTTPS.
- **Dokploy:** Create Service → Compose → Git provider or raw file. Add the env vars, then add a domain for `app:8080`.
- **CapRover:** Deploy the `app` with the image `ghcr.io/housewithbricks/open-crm:latest` (port 8080). Create Postgres from the one-click apps and set `DATABASE_URL`.
- **Portainer / Unraid / Synology:** Create a stack from `deploy/docker-compose.yml` and set `ADMIN_PASSWORD`.

Leave out the `caddy` service: these platforms already do HTTPS.

---

## Anything else

The image is published to GitHub Container Registry on every push to `main` (see [`.github/workflows/docker.yml`](../.github/workflows/docker.yml)):

```
ghcr.io/housewithbricks/open-crm:latest        # the app, linux/amd64 + linux/arm64
ghcr.io/housewithbricks/open-crm-site:latest   # the landing page (optional)
```

Run it anywhere with `DATABASE_URL` and `ADMIN_PASSWORD` set, port `8080` exposed, and `/health` as the health check: Kubernetes, Nomad, ECS, Cloud Run, Azure Container Apps, Koyeb, Northflank, Zeabur and so on. Example:

```bash
docker run -d -p 8080:8080 \
  -e DATABASE_URL="postgres://user:pass@your-db:5432/opencrm?sslmode=require" \
  -e ADMIN_PASSWORD="…" \
  ghcr.io/housewithbricks/open-crm:latest
```

Serverless platforms that scale to zero (Cloud Run, Fly) work fine. Keep `DATABASE_POOL_SIZE` small (e.g. `3`) if your database limits connections.

---

## Connecting agents

After deploying, go to **Settings → API keys & MCP**, create a key, and connect:

```bash
claude mcp add --transport http open-crm https://crm.example.com/mcp \
  --header "Authorization: Bearer ocrm_…"
```

MCP is served over HTTPS by whatever is in front of the container (the platform, Caddy or your reverse proxy). Agents only need the URL and a key.

## Security checklist

- Use a long, random `ADMIN_PASSWORD`. Changing it signs out every browser. **Settings → API keys & MCP → Sign out everywhere** does the same without a password change.
- Serve over HTTPS. Every option above does, except plain `docker compose up` with `BIND_ADDRESS=0.0.0.0` on a LAN.
- The compose files publish the app on `127.0.0.1` only. Leave it that way when you use the `https` profile, so nobody can skip Caddy.
- Set `TRUSTED_PROXY_HOPS` to match your setup (see the table above) so the sign-in limiter sees real client addresses.
- `LOGIN_GLOBAL_MAX` caps failed sign-ins from all addresses together, so password guessing spread over many addresses gets nowhere. The flip side: anyone who can reach the sign-in page can fail that many times on purpose and pause new sign-ins for 5 minutes, again and again. Browsers that are already signed in and API keys (so your agents) keep working. If that happens, raise `LOGIN_GLOBAL_MAX` (e.g. `1000`; a long random password stays out of reach), or put the app behind a VPN, Cloudflare Access or your proxy's IP allowlist so strangers can't reach it.
- Give each agent its own API key with only the scopes it needs, and revoke keys you no longer use.
- Back up Postgres.
