import { HeadContent, Outlet, Scripts, createRootRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AuthProvider, UserChip } from "~/components/auth.tsx";
import styles from "~/styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "kapi — AI engineering team" },
    ],
    links: [{ rel: "stylesheet", href: styles }],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <AuthProvider>
      <div className="min-h-screen">
        <header className="sticky top-0 z-20 border-b border-line/50 bg-ink/85 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center gap-4 px-6 py-3">
            <Link to="/" className="flex items-center gap-2.5">
              <span className="grid size-7 place-items-center rounded-lg bg-accent font-bold text-ink">k</span>
              <span className="font-semibold tracking-tight">kapi</span>
            </Link>
            <span className="text-xs text-muted">your AI engineering team</span>
            <UserChip />
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-6 py-8">
          <Outlet />
        </main>
      </div>
      </AuthProvider>
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head><HeadContent /></head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
