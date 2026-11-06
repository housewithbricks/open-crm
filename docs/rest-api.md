# REST API

Everything the web UI does goes through a JSON API at `/api`. Agents usually use [MCP](connecting-agents.md) instead; the REST API is for scripts, integrations and anything that doesn't speak MCP. Both use the same API keys and the same rules.

## Auth

Send one of:

- **An API key:** `Authorization: Bearer ocrm_…`. Create keys in **Settings → API keys & MCP**.
- **A session cookie:** `POST /api/login` with `{"password": "…"}` sets an `ocrm_session` cookie. This is how the web UI signs in. `POST /api/logout` clears it.

Without either you get `401`.

### Scopes

An API key has one or more scopes:

| Scope | Allows |
|---|---|
| `read` | Every `GET` route: records, search, schema, views, tasks, timeline, CSV export, dashboard, audit log, approvals list. `GET /api/me` works without it. |
| `write` | Create, update, archive and restore records; notes and tasks; saved views; CSV import. |
| `schema` | Create and edit objects and fields. Destructive changes (archive a field or object, change a field's type, remove options) become change requests that wait for approval. |

A missing scope is a `403`. A key without `read` can still write, but writes then return only `{"id": "…", "action": "created" | "updated" | "restored"}`, never the stored record.

### Session only

These routes refuse API keys (`403`) and need a signed-in session:

- webhooks: everything under `/api/webhooks`
- API keys: everything under `/api/keys`
- approving or rejecting a change request: `POST /api/changes/:id/approve`, `POST /api/changes/:id/reject`
- undo: `POST /api/audit/:id/undo`
- appearance settings: `PATCH /api/settings`
- sign out everywhere: `POST /api/logout-all`

## Errors

Errors are JSON: `{"error": "message", "details": …}` with a `4xx` status. The message says what to fix (for example the valid fields or options). `409` means a conflict, such as a duplicate unique value or an undo of something that changed again since.

## Routes

`:slug` is an object's slug (`people`, `companies`, `deals` or your own). `:id` is a record id (UUID).

### Records

| Method and path | Scope | |
|---|---|---|
| `GET /api/objects/:slug/records` | read | List. Query: `q` (text), `filters` (JSON array, see below), `sort` (field key, `created_at`, `updated_at`), `dir` (`asc`/`desc`), `limit` (default 100, at most 500), `offset`. Returns `{total, records, refs}`; `refs` has names for relation ids. |
| `GET /api/objects/:slug/groups?field=stage&sum=amount` | read | Count (and an optional sum) per option of a select field. Takes the same `q` and `filters`. |
| `POST /api/objects/:slug/records` | write | Create. Body: field values keyed by field key. |
| `GET /api/records/:id` | read | One record with `refs` and `related` (records that link to it). |
| `PATCH /api/records/:id` | write | Update the fields you send. `null` clears a field. |
| `DELETE /api/records/:id` | write | Archive. |
| `POST /api/records/:id/restore` | write | Restore an archived record. |
| `GET /api/records/:id/timeline` | read | Notes, tasks and field changes, newest first. |
| `GET /api/search?q=…` | read | Search all objects by name and field values. |

Filters are ANDed, each `{"field", "op", "value"}`. Ops: `eq`, `neq`, `contains`, `gt`, `gte`, `lt`, `lte`, `between` (`[min, max]`), `in`, `not_in`, `is_empty`, `not_empty`. Dates also take `today`, `today+7`, `today-30`. Example: `filters=[{"field":"amount","op":"gte","value":10000}]` (URL-encoded).

### Notes and tasks

| Method and path | Scope | |
|---|---|---|
| `POST /api/records/:id/activities` | write | Add a note, call, email, meeting or task to a record. Body: `{kind, title?, body, due_at?}`. |
| `POST /api/activities` | write | Same, linked to several records: `{record_ids: […], kind, …}`. |
| `PATCH /api/activities/:id` | write | Edit `title`, `body`, `due_at`, `done` or `record_ids`. |
| `DELETE /api/activities/:id` | write | Delete (undoable from the audit log). |
| `GET /api/tasks` | read | Open tasks. `?all=1` includes done ones, `?record_id=` limits to one record. |

### Schema

| Method and path | Scope | |
|---|---|---|
| `GET /api/schema` | read | All objects with their fields, and record counts. |
| `POST /api/objects` | schema | Create an object: `{label, label_plural?, description?, color?, fields?: […]}`. |
| `PATCH /api/objects/:slug` | schema | Rename, describe, recolor or change the primary field. |
| `DELETE /api/objects/:slug` | schema | Archive the object (a change request for API keys). |
| `POST /api/objects/:slug/fields` | schema | Add a field: `{label, type, key?, description?, required?, unique?, choices?, target?, multiple?, currency?}`. |
| `PATCH /api/objects/:slug/fields/:key` | schema | Edit label, description, required or options (`add_choices`, or `choices` for the full list). `type` or `remove_choices` are destructive (change requests for API keys). |
| `DELETE /api/objects/:slug/fields/:key` | schema | Archive the field (a change request for API keys). |

Field types: `text`, `long_text`, `number`, `currency`, `date`, `boolean`, `select`, `multi_select`, `email`, `url`, `phone`, `relation`.

### Views, import and export

| Method and path | Scope | |
|---|---|---|
| `GET /api/objects/:slug/views` | read | Saved views. |
| `POST /api/objects/:slug/views` | write | Save a view: `{name, config: {kind?, q?, filters?, sort?, dir?, group_by?}}`. |
| `PATCH /api/views/:id`, `DELETE /api/views/:id` | write | Edit or delete a view. |
| `POST /api/objects/:slug/import` | write | `{rows: […], match_on?, create_missing_relations?, add_missing_options?}`. Up to 5,000 rows. Relation values may be names. Adding options needs `schema` too. Each row succeeds or fails on its own. |
| `GET /api/objects/:slug/export.csv` | read | CSV of every record. |

### Approvals, audit, dashboard

| Method and path | Scope | |
|---|---|---|
| `GET /api/changes?status=pending` | read | Change requests. |
| `POST /api/changes/:id/approve`, `…/reject` | session | Decide a change request. |
| `GET /api/audit?limit=200` | read | Audit log, newest first (`limit` at most 1000). Each entry says whether it is `undoable`. |
| `POST /api/audit/:id/undo` | session | Undo an entry. Body `{"force": true}` overwrites changes made since. |
| `GET /api/dashboard` | read | Pipeline, win rate, tasks and activity numbers. |
| `GET /api/me` | any | Who the key or session is, and the MCP URL. |

### Session-only settings

| Method and path | |
|---|---|
| `GET /api/settings`, `PATCH /api/settings` | Theme and accent color. Reading needs `read`; changing needs a session. |
| `GET/POST /api/webhooks`, `PATCH/DELETE /api/webhooks/:id`, `POST /api/webhooks/:id/test` | Webhooks. |
| `GET/POST /api/keys`, `DELETE /api/keys/:id` | API keys. |
| `POST /api/logout-all` | Sign out every browser. API keys keep working. |
