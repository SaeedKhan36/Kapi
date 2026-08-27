import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Logo } from "./Logo.tsx";
import { UserMenu } from "./auth.tsx";

/**
 * The frame around every signed-in page.
 *
 * Deliberately thin: one row of chrome, then the work. A run view is already
 * dense with status, and a sidebar of navigation for two destinations would
 * be furniture competing with it.
 */
export function AppShell({ children, back }: {
  children: ReactNode;
  /** Shown instead of the section label when a page is nested under the dashboard. */
  back?: { to: string; label: string };
}) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b-[1.5px] border-line/20 bg-[#f7f4ec]/85 backdrop-blur-xl">
        <div className="shell flex h-16 items-center gap-4">
          <Link to="/" aria-label="kapi home"><Logo /></Link>

          <span aria-hidden className="h-5 w-px bg-line/25" />

          {back ? (
            <Link
              to={back.to}
              className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-medium text-muted transition-colors hover:bg-raised hover:text-bright"
            >
              <ArrowLeft className="size-3.5" /> {back.label}
            </Link>
          ) : (
            <span className="rounded-full border-[1.5px] border-line bg-[#e9d5ff] px-2.5 py-0.5 text-xs font-semibold">
              Dashboard
            </span>
          )}

          <div className="ml-auto flex items-center gap-4">
            <UserMenu />
          </div>
        </div>
      </header>

      <main className="shell py-8 lg:py-10">{children}</main>
    </div>
  );
}
