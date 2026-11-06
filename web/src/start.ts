import { createStart } from "@tanstack/react-start";

// The CRM is behind a login and loads its data with TanStack Query in the browser,
// so pages render on the client. The server renders the document shell and hosts /api and /mcp.
export const startInstance = createStart(() => ({
  defaultSsr: false,
}));
