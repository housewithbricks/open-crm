import { QueryClientProvider, useQuery, type QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import Login from "../components/Login";
import Shell from "../components/Shell";
import { api, ApiError, queryClient } from "../lib/api";
import appCss from "../styles.css?url";

// Apply the saved theme and accent before first paint (cached from Settings → Appearance).
const themeBoot = `try{var u=JSON.parse(localStorage.getItem("ocrm-ui")||"{}");var d=u.theme==="dark"||(u.theme!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=d?"dark":"light";if(u.accent)document.documentElement.style.setProperty("--accent-base",u.accent)}catch(e){}`;

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  // ?r=<record id> opens the record drawer on any page.
  validateSearch: (s: Record<string, unknown>): { r?: string } => (typeof s.r === "string" && s.r ? { r: s.r } : {}),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Open CRM" },
      { name: "description", content: "Open CRM: your server, your data, your agents." },
      { name: "theme-color", content: "#0f172a" },
    ],
    links: [
      { rel: "icon", href: "/favicon.svg" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" },
      { rel: "stylesheet", href: appCss },
    ],
    scripts: [{ children: themeBoot }],
  }),
  shellComponent: Document,
  component: App,
});

function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate />
    </QueryClientProvider>
  );
}

function AuthGate() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api("/me"), retry: false });
  if (me.isLoading) return null;
  if (me.error instanceof ApiError && me.error.status === 401) return <Login />;
  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}
