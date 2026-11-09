# Connecting agents to Open CRM

Open CRM is an MCP server. Any MCP client can connect to it:

| | |
|---|---|
| **URL** | `https://YOUR-HOST/mcp` |
| **Transport** | Streamable HTTP (stateless, JSON responses) |
| **Auth** | `Authorization: Bearer ocrm_…`, or `?key=ocrm_…` in the URL for clients that only take a URL |

First create a key in **Settings → API keys & MCP**. Give each agent its own key. Its changes show up under the key's name, and you can revoke it on its own. Scopes:
- `read` lets it search and view. Over MCP and REST, a key without it can't read any records, search, exports, the audit log or the dashboard.
- `write` lets it create and update records, notes, tasks and saved views. Without `read`, these writes return only the id and what happened (`{"id", "action"}`), never the stored record, activity or view.
- `schema` lets it add objects and fields. Destructive changes (archiving a field or object, changing a field's type, removing options) still wait for your approval.

### Source links

Every record, note and task write tool (`create_record`, `update_record`, `upsert_record`, `bulk_upsert_records`, `archive_record`, `log_activity`, `create_task`, `update_task`, `complete_task`) takes an optional `source`. Use it to say what the write is based on:

```json
{ "id": "…", "data": { "stage": "Negotiation" },
  "source": { "url": "https://mail.google.com/mail/u/0/#inbox/18f2…", "label": "Email from Dana: ready to sign" } }
```

The change shows a **Source** link in the record timeline and the audit log, so you can open the email (or doc, meeting, ticket) right from the change. It is also in webhook payloads as `source`. Only `http://` and `https://` links are accepted. Labels are cut to 200 characters.

**Fingerprinting the source.** A link shows where the agent looked, not what it read. Add `source.text` with the text the agent read (for example the email body). Open CRM stores a fingerprint of it with the change and doesn't store the text. Later, `check_source` (or **check** next to the source link in the app) takes the source as it reads now and says whether it matches. Only the fingerprint is kept, so a mismatch can't show what changed.

```json
"source": { "url": "https://mail.google.com/…", "label": "Email from Dana", "text": "Hi team, we're ready to sign…" }
```

- Text is prepared as `text-v1`: Unicode NFC, each run of `White_Space` characters (spaces, tabs, line breaks, no-break spaces) becomes one space, then trimmed. Rewrapping and line endings don't matter, but any change to the words does.
- The fingerprint is an HMAC-SHA256 with a random salt per write and a per-install key. The entries one call makes, such as a bulk upsert, share it, the same way they share the link. The key is stored in your Open CRM database, or in `SOURCE_DIGEST_KEY` if you set it, and is never sent to clients or webhooks. Someone who sees the value (a read key, a webhook receiver) can't test guesses of short texts like "Yes, approved" against it offline. They also can't tell that two separate writes were based on the same text. `check_source` answers only match or no match. Still, a key with the `read` scope can test one guess per call that way, so the fingerprint confirms content; it doesn't hide it. Someone with a database backup that includes the key can test guesses offline. If the key changes or is lost, older fingerprints can't be checked: the check says so instead of reporting a mismatch.
- A mismatch means the text differs from what the agent sent. The source may have been edited, or the copy being checked may differ from what the agent got: quoted replies, a signature, or a different part of the email. For a firm answer, have the agent fetch the source the same way it did before and run `check_source`.

If one of the agent's tools already hashes what it fetched, pass that hash as `source.digest`: `"sha256:<canon>:<hex>"`, where `canon` names how the tool prepared the bytes. If `canon` is left out (`"sha256:<hex>"`), it is stored as `unspecified`. The app shows these as *reported*, since Open CRM never saw the text. Open CRM can check them against new text only for the canons `text-v1` and `raw` (exact UTF-8 bytes, API only). Any other canon is checked against a new hash from the same tool. Don't let a model write a hash itself: it can't compute one.

**Requiring a source.** For a key that acts on things you can link to, such as an agent that reads your inbox, turn on **Require a source** when you create the key (or with the **Needs source** switch in the key list). Its record, note and task writes are then refused without a `source`, with an error that says so, and nothing is changed. Reads and schema changes are not affected. The key's MCP instructions tell the agent about the rule.

Below, replace `https://YOUR-HOST` with your Open CRM address and `ocrm_…` with your key.

---

## Claude Code

```bash
claude mcp add --transport http open-crm https://YOUR-HOST/mcp \
  --header "Authorization: Bearer ocrm_…"
```

Add `--scope user` to make it available in every project.

## Claude (web and desktop app): custom connector

Claude's custom connectors take a URL, not headers, so put the key in the URL:

1. **Settings → Connectors → Add custom connector**
2. Name it `Open CRM` and use the URL `https://YOUR-HOST/mcp?key=ocrm_…`

Custom connectors need a paid Claude plan, and on Team/Enterprise an owner may need to add the connector for you. Treat this URL like a password (see [Keys in URLs](#keys-in-urls)).

### Claude Desktop with a config file (alternative)

If you'd rather keep the key out of the URL, bridge with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) in `claude_desktop_config.json` (Settings → Developer → Edit Config). This needs Node.js:

```json
{
  "mcpServers": {
    "open-crm": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://YOUR-HOST/mcp", "--header", "Authorization:${OPEN_CRM_AUTH}"],
      "env": { "OPEN_CRM_AUTH": "Bearer ocrm_…" }
    }
  }
}
```

## ChatGPT

ChatGPT connects to custom MCP servers in **developer mode**:

1. **Settings → Apps & Connectors → Advanced settings**, and turn on **Developer mode**.
2. **Create** a connector (app). Name it `Open CRM`, use the URL `https://YOUR-HOST/mcp?key=ocrm_…` and choose **No authentication** (the key in the URL is the authentication).
3. In a chat, turn on the connector from the tools menu.

Developer mode is available on paid plans, and workspace admins may need to allow it. ChatGPT asks you to confirm before each write. Menu names change from time to time.

## OpenAI API (Responses API)

```json
{
  "type": "mcp",
  "server_label": "open_crm",
  "server_url": "https://YOUR-HOST/mcp",
  "headers": { "Authorization": "Bearer ocrm_…" },
  "require_approval": "never"
}
```

Pass this in `tools`. Use `"require_approval": "always"` to review writes.

## Cursor

**Settings → MCP → Add new MCP server**, or edit `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "open-crm": {
      "url": "https://YOUR-HOST/mcp",
      "headers": { "Authorization": "Bearer ocrm_…" }
    }
  }
}
```

## VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json` in your workspace (or **MCP: Add Server** from the command palette). This setup asks for the key once and stores it securely:

```json
{
  "inputs": [{ "id": "openCrmKey", "type": "promptString", "description": "Open CRM API key", "password": true }],
  "servers": {
    "open-crm": {
      "type": "http",
      "url": "https://YOUR-HOST/mcp",
      "headers": { "Authorization": "Bearer ${input:openCrmKey}" }
    }
  }
}
```

## Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "open-crm": {
      "serverUrl": "https://YOUR-HOST/mcp",
      "headers": { "Authorization": "Bearer ocrm_…" }
    }
  }
}
```

## Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "open-crm": {
      "httpUrl": "https://YOUR-HOST/mcp",
      "headers": { "Authorization": "Bearer ocrm_…" }
    }
  }
}
```

## OpenAI Codex CLI

`~/.codex/config.toml` (recent Codex versions), with the key in an environment variable:

```toml
[mcp_servers.open-crm]
url = "https://YOUR-HOST/mcp"
bearer_token_env_var = "OPEN_CRM_KEY"
```

```bash
export OPEN_CRM_KEY=ocrm_…
```

## Any other client

- **Supports remote (HTTP) MCP servers with headers:** use the URL plus the `Authorization: Bearer ocrm_…` header. The JSON shape is usually one of the above (`url` / `serverUrl` / `httpUrl` + `headers`).
- **Takes only a URL:** use `https://YOUR-HOST/mcp?key=ocrm_…`.
- **Supports only local (stdio) servers:** run the `mcp-remote` bridge as the command:

  ```bash
  npx -y mcp-remote https://YOUR-HOST/mcp --header "Authorization:Bearer ocrm_…"
  ```

- **Your own code:** POST JSON-RPC to `/mcp` with `Accept: application/json, text/event-stream`. With the official SDKs, use the Streamable HTTP client transport and set the header. Or skip MCP and use the REST API at `/api` with the same key.

Check that it works by asking the agent: *"Describe my Open CRM schema."* It should call `describe_schema`.

---

## Keys in URLs

`?key=` exists for clients that can't send headers. A URL with a key in it is a password:
- Use HTTPS. Every deployment option in the [self-hosting guide](self-hosting.md) does.
- Don't paste it anywhere shared.
- Make a separate key for each connector, and revoke it in **Settings → API keys & MCP** if it leaks.
- Prefer the header wherever your client supports it.

## Troubleshooting

- **401 "Missing or invalid API key".** The key is wrong or revoked, or the header isn't being sent. Try the `?key=` URL to tell which.
- **The tools list is shorter than expected.** The key is missing a scope. Create a new key with `write` and/or `schema`.
- **"Method not allowed".** The server is stateless and only answers `POST /mcp`. Use a client that supports Streamable HTTP, or `mcp-remote`.
- **Behind a reverse proxy.** Make sure it passes the `Authorization` header through and doesn't buffer responses for long.
