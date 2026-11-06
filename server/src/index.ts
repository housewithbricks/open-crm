/**
 * Standalone API + MCP server (no web UI). Used by the test suite and for API-only runs.
 * In production the same app is mounted inside the TanStack Start server (see web/).
 */
import { serve } from "@hono/node-server";
import { app, ensureReady } from "./app.js";
import { config } from "./config.js";

ensureReady()
  .then(() => {
    serve({ fetch: app.fetch, port: config.port }, (info) => {
      console.log(`[open-crm] API listening on http://localhost:${info.port}  (MCP at /mcp)`);
    });
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
