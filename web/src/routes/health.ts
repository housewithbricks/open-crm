import { createFileRoute } from "@tanstack/react-router";
import { handle } from "server/app";

export const Route = createFileRoute("/health")({
  server: { handlers: { GET: ({ request }) => handle(request) } },
});
