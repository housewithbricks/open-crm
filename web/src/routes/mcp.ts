import { createFileRoute } from "@tanstack/react-router";
import { handle } from "server/app";

// MCP over Streamable HTTP, served by the same Hono app.
const toHono = ({ request }: { request: Request }) => handle(request);

export const Route = createFileRoute("/mcp")({
  server: { handlers: { GET: toHono, POST: toHono, DELETE: toHono } },
});
