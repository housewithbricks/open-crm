/**
 * The Open CRM HTTP app: REST API at /api, MCP at /mcp, health at /health.
 * It is a plain Hono app with a web-standard fetch(), so it can be mounted anywhere:
 * inside the TanStack Start server (production) or standalone (tests, API-only dev).
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { api } from "./api/routes.js";
import { actorFromApiKey, initAuth } from "./core/auth.js";
import { seed } from "./core/seed.js";
import { CrmError } from "./core/types.js";
import { migrate, sql } from "./db.js";
import { buildMcpServer } from "./mcp/server.js";

export const app = new Hono();

app.onError((err, c) => {
  if (err instanceof CrmError) return c.json({ error: err.message, details: err.details }, err.status as 400);
  if (err instanceof SyntaxError) return c.json({ error: "Invalid JSON body" }, 400);
  // Postgres data exceptions (class 22: a malformed uuid, date or number) come from bad input, not a server fault.
  if (/^22/.test((err as { code?: string }).code ?? "")) return c.json({ error: `Invalid value: ${err.message}` }, 400);
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

app.get("/health", async (c) => {
  await sql`select 1`;
  return c.json({ ok: true });
});

/* ----------------------------------- MCP ----------------------------------- */
// Stateless Streamable HTTP: each request gets its own server, scoped to the API key's permissions.
// The key comes from "Authorization: Bearer <key>", or from ?key=<key> for clients that can only take a URL
// (Claude and ChatGPT custom connectors). Treat such a URL as a secret.
app.all("/mcp", async (c) => {
  const key = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") || c.req.query("key");
  const actor = await actorFromApiKey(key);
  if (!actor) {
    return c.json({ jsonrpc: "2.0", error: { code: -32001, message: "Missing or invalid API key. Create one in Open CRM under Settings → API keys & MCP." }, id: null }, 401);
  }
  if (c.req.method !== "POST") {
    return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null }, 405);
  }
  const server = buildMcpServer(actor);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

/* ----------------------------------- API ----------------------------------- */
app.route("/api", api);

/* ---------------------------------- startup -------------------------------- */
let ready: Promise<void> | null = null;

/** Run migrations, auth setup and the first-boot seed exactly once per process. */
export function ensureReady() {
  ready ??= (async () => {
    await migrate();
    await initAuth();
    await seed();
  })().catch((e) => {
    ready = null; // allow a retry, e.g. if the database wasn't up yet
    throw e;
  });
  return ready;
}

/** fetch() that waits for startup first: what a host server should call. */
export async function handle(request: Request) {
  await ensureReady();
  return app.fetch(request);
}
