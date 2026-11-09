<p align="center"><img src="web/public/favicon.svg" width="72" alt="Open CRM"></p>

# Open CRM

**Your server. Your data. Your agents.**

A small, self-hosted CRM where **you and your AI agents are equal clients**. It has a web UI for you and an MCP server for Claude or any other MCP client. Both sit on the same service layer, and the agent can grow the CRM itself: new objects, new fields, new options.

- **Schema stored as data.** Objects (People, Companies, Deals, …) and their fields live in the database. Add a field or a whole object, from the UI or through MCP, and every table, form and board picks it up instantly.
- **MCP built in** at `/mcp` (Streamable HTTP). Scoped API keys (`read`, `write`, `schema`), one per agent. A key can be set to require a source link on every write.
- **Attributed and reversible.** Every write shows up in the record's timeline and the audit log with who made it. From the audit log you can **undo** record creates, edits, archives and restores; note and task creates, edits and deletes; new and edited fields (including option labels, colors, order and stage settings); new and edited objects (name, description, icon, color and primary field); and archived fields and objects. Undoing an edit warns you if those values changed again since. Field type changes and removed options can't be undone. **Undo an agent's changes** rolls back everything one key did in a time window, after showing you a preview; anything someone else edited afterwards is left alone.
- **Guardrails for agents.** Agents can add things freely. Destructive schema changes (archive or retype a field, archive an object, remove options) go to an **Approvals** inbox. A type change converts every stored value or, if some can't be converted, is refused with a count and changes nothing.
- **Views, filters, import and export.** Save filtered views (agents can too), import CSVs with column mapping and dedupe, and export any object.
- **Webhooks.** Signed HTTP events (`record.created`, `record.updated`, `schema.changed`, …) so automations and agents can react.
- **One container + Postgres.** Runs on a laptop, a VPS, Railway, Render, Fly.io, DigitalOcean, Heroku or your own PaaS.

## Self-host

Open CRM is one container plus Postgres. Run it anywhere Docker runs:

```bash
git clone https://github.com/housewithbricks/open-crm.git && cd open-crm
cp .env.example .env        # set ADMIN_PASSWORD
docker compose up -d        # → http://localhost:8080
```

Add `DOMAIN=crm.example.com` to `.env` and run `docker compose --profile https up -d` for automatic HTTPS with Caddy.

Or deploy in one click:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/housewithbricks/open-crm)
[![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/housewithbricks/open-crm/tree/main)
[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/housewithbricks/open-crm)

**[Self-hosting guide →](docs/self-hosting.md)** covers Railway, Fly.io, Coolify, Dokploy, CapRover, Portainer, Kubernetes, the prebuilt `ghcr.io` image, HTTPS, backups and upgrades.

> Deploying from your fork? Swap `housewithbricks` for your GitHub user in these links.

## Connect your agent (MCP)

Create a key in **Settings → API keys & MCP**, then point any MCP client at `https://YOUR-HOST/mcp`:

| Client | How |
|---|---|
| Claude Code | `claude mcp add --transport http open-crm https://YOUR-HOST/mcp --header "Authorization: Bearer ocrm_…"` |
| Claude (web/desktop) | Settings → Connectors → Add custom connector → `https://YOUR-HOST/mcp?key=ocrm_…` |
| ChatGPT | Developer mode → create connector → `https://YOUR-HOST/mcp?key=ocrm_…`, no authentication |
| Cursor, VS Code, Windsurf, Gemini CLI, Codex | `url` + `Authorization: Bearer` header in the client's MCP config |
| OpenAI API | `{"type":"mcp","server_url":"https://YOUR-HOST/mcp","headers":{"Authorization":"Bearer ocrm_…"}}` |
| Anything else | Streamable HTTP + bearer header, `?key=` for URL-only clients, or `npx mcp-remote` for stdio-only clients |

Exact config files for each client are in **[docs/connecting-agents.md](docs/connecting-agents.md)**. Scripts and integrations can use the same keys over JSON: see the **[REST API reference](docs/rest-api.md)**.

### MCP surface

| Scope | Tools |
|---|---|
| read | `describe_schema`, `search`, `list_records` (filters: eq, neq, contains, gt/gte/lt/lte, between, in/not_in, is_empty, not_empty; or a saved `view`), `get_record` (with related records + timeline), `list_views`, `list_tasks`, `get_overview` (pipeline, win rate, tasks, activity) |
| write | `create_record`, `update_record`, `upsert_record` (dedupe on email/domain/…), `bulk_upsert_records` (up to 500; relations by name), `archive_record`, `log_activity`, `create_task`, `update_task`, `complete_task`, `save_view`, `update_view`, `delete_view` |
| schema | `create_object_type`, `update_object_type`, `add_field`, `update_field` (add, rename, recolor, reorder options; stage kind and win %), `request_schema_change` (goes to Approvals) |

Resources: `crm://schema`, `crm://records/{id}`. Prompts: `pipeline_review`, `meeting_prep`.

Field types: text, long_text, number, currency, date, boolean, select, multi_select, email, url, phone, relation.

## Local development

Requires Node 22, pnpm and a Postgres (e.g. `docker run -d -p 5432:5432 -e POSTGRES_USER=opencrm -e POSTGRES_PASSWORD=opencrm -e POSTGRES_DB=opencrm postgres:17-alpine`).

```bash
pnpm install
DATABASE_URL=postgres://opencrm:opencrm@localhost:5432/opencrm ADMIN_PASSWORD=dev pnpm dev
#   → http://localhost:5173: UI, REST API (/api) and MCP (/mcp) in one process, with hot reload
pnpm test     # end-to-end tests (REST + MCP) against a throwaway database
pnpm build    # production bundle in web/.output; run with: pnpm start
```

**Stack:** [TanStack Start](https://tanstack.com/start) (React 19, file-based routes, TanStack Query) and Tailwind CSS v4 for the web app; Hono for the REST API and MCP server; Postgres via postgres.js. In production, Nitro bundles everything into one self-contained Node server (`web/.output`), which is what the Docker image runs.

Tests boot the real server against a fresh `opencrm_test` database, created from `TEST_DATABASE_URL` (by default the local dev Postgres above).

## Webhooks

**Settings → Webhooks.** Each delivery is a `POST` with JSON `{ id, event, action, actor, object, target_id, before, after, source, at }` (`source` is the `{url, label}` link a write was based on, or `null`) and these headers:
- `x-opencrm-event`
- `x-opencrm-event-id`: the same as `id`
- `x-opencrm-attempt`: `1`, `2` or `3`
- `x-opencrm-signature: sha256=<HMAC-SHA256 of the raw body with the endpoint secret>`

`id` is unique per event and stays the same on every retry. If a delivery is retried after a lost response, you get the same event again, so use `id` as an idempotency key (for example a unique key on the jobs an agent starts) to avoid acting twice.

Events: `record.created`, `record.updated`, `record.archived`, `record.restored`, `activity.created`, `schema.changed`, `change.requested`, `change.decided`. Failed deliveries are retried twice. Redirects are not followed. Link-local and cloud metadata addresses (169.254.0.0/16, fe80::/10) are refused unless `WEBHOOK_ALLOW_PRIVATE=1`; localhost and private networks are allowed.

## Layout

```
server/src
  core/        service layer: schema, records, activities, changes (approvals), audit, undo,
               views, importer (CSV + bulk upsert), webhooks, auth, seed
  mcp/         MCP tools/resources/prompts. Thin adapter over core
  api/         REST routes. Thin adapter over core
  db.ts        postgres.js client + versioned migrations (append-only)
  app.ts       the Hono app: /api, /mcp, /health (mounted by the web server)
  index.ts     standalone API-only server (used by the tests)
web/src
  routes/      TanStack Start file routes; api/$.ts, mcp.ts and health.ts hand requests to the Hono app
  pages/       Home (analytics), ObjectPage (views / filters / table / board), Tasks, Approvals, settings
  components/  Tailwind UI: primitives (ui.tsx), select, fields, filters, record drawer, stage editor, charts
  lib/         API client, theme, formatting, schema hooks
  styles.css   Tailwind v4 + design tokens (light/dark, accent, object colors) as CSS variables
site/          landing page + its nginx container
deploy/        prebuilt-image compose file and Caddyfile
docs/          self-hosting guide
render.yaml, app.json + heroku.yml, .do/, fly.toml   one-click / platform configs (Railway needs none: see docs/self-hosting.md)
```

**Rule:** business logic lives only in `server/src/core`. REST and MCP stay thin, so the UI and agents always behave the same way.

## Landing page

`site/` is the project's landing page: static files served by its own small nginx container (`site/Dockerfile`). Run it with `docker compose --profile site up -d`, or deploy that folder to any static host. See [site/README.md](site/README.md).

## Roadmap

- pgvector semantic search over notes and records
- Scheduled agent jobs (e.g. weekly pipeline review) triggered from the CRM
- Email and calendar sync; OAuth for MCP

## License

[MIT](LICENSE). Use it, fork it, build your own on top of it.
