import { SignIn, SignUp } from "@clerk/react";
import { Link, Navigate } from "@tanstack/react-router";
import { GitBranch, Boxes, Radio } from "lucide-react";
import { authEnabled } from "~/lib/auth.ts";
import { Logo } from "./Logo.tsx";

/**
 * Sign in beside a reminder of what is behind the door.
 *
 * Clerk's widget renders in virtual routing mode, so every step of the flow -
 * password, second factor, verification - stays on this one route rather than
 * needing a catch-all path per step.
 */
const POINTS = [
  { icon: Boxes, text: "A sandbox per worker, torn down when idle" },
  { icon: GitBranch, text: "Real commits on a branch you can review" },
  { icon: Radio, text: "Every agent message, streamed live" },
] as const;

export function AuthPage({ mode }: { mode: "sign-in" | "sign-up" }) {
  // Nothing to sign into in single-operator mode; the dashboard is already open.
  if (!authEnabled) return <Navigate to="/app" replace />;

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <aside className="hidden flex-col justify-between border-r border-line/40 bg-surface/30 p-10 lg:flex">
        <Link to="/" aria-label="kapi home"><Logo /></Link>

        <div>
          <h1 className="max-w-sm text-3xl font-semibold leading-tight tracking-tight">
            Delegate the whole feature, not the next line.
          </h1>
          <ul className="mt-8 space-y-4">
            {POINTS.map((point) => (
              <li key={point.text} className="flex items-center gap-3 text-sm text-muted">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-accent/25 bg-accent/10 text-accent">
                  <point.icon className="size-4" />
                </span>
                {point.text}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-dim">
          kapi never stores your GitHub token — it borrows the grant per request.
        </p>
      </aside>

      <main className="grid place-items-center px-6 py-16">
        <div className="w-full max-w-md">
          <Link to="/" className="mb-8 flex justify-center lg:hidden"><Logo /></Link>
          <div className="flex justify-center">
            {mode === "sign-in"
              ? <SignIn signUpUrl="/sign-up" fallbackRedirectUrl="/app" />
              : <SignUp signInUrl="/sign-in" fallbackRedirectUrl="/app" />}
          </div>
        </div>
      </main>
    </div>
  );
}
