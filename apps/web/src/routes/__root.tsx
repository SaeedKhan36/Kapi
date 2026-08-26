import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AuthProvider } from "~/components/auth.tsx";
import styles from "~/styles.css?url";

/**
 * The document and the session, and nothing else.
 *
 * The marketing pages and the dashboard want different chrome, so neither is
 * imposed here - each branch of the route tree brings its own shell.
 */
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "color-scheme", content: "dark" },
      { title: "kapi — your AI engineering team" },
      {
        name: "description",
        content:
          "kapi turns one goal into a task graph and runs a specialist agent on every branch of it — each in its own sandbox, each on its own git branch.",
      },
      { property: "og:title", content: "kapi — your AI engineering team" },
      {
        property: "og:description",
        content: "A free, open multi-agent AI engineering team. Plans, splits, and builds in parallel.",
      },
      { property: "og:type", content: "website" },
    ],
    links: [
      { rel: "stylesheet", href: styles },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <AuthProvider>
        <Outlet />
      </AuthProvider>
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head><HeadContent /></head>
      <body className="min-h-screen antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
