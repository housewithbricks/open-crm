import { createFileRoute } from "@tanstack/react-router";
import { handle } from "server/app";

// Everything under /api is the Hono REST API (same app the MCP tools use).
const toHono = ({ request }: { request: Request }) => handle(request);

export const Route = createFileRoute("/api/$")({
  server: { handlers: { GET: toHono, POST: toHono, PATCH: toHono, PUT: toHono, DELETE: toHono } },
});
