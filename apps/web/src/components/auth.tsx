import { ClerkProvider, UserButton, useAuth, useClerk } from "@clerk/react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { CLERK_PUBLISHABLE_KEY, authEnabled, setTokenSource } from "~/lib/auth.ts";
import { buttonClass, Spinner } from "./ui.tsx";

/**
 * Wraps the app in a Clerk session, when there is one to have.
 *
 * With no publishable key configured this renders its children untouched,
 * which is the single-operator path: kapi is meant to work with nothing but a
 * Gemini key, and a login screen in front of a one-person deployment is
 * friction without a purpose. Every export below makes the same check, so no
 * caller has to.
 */

/** Clerk's own widgets, dressed in kapi's pastel palette. */
const appearance = {
  variables: {
    colorPrimary: "#7dd3fc",
    colorBackground: "#fffdf8",
    colorForeground: "#1c1917",
    colorInputBackground: "#ffffff",
    colorInputForeground: "#1c1917",
    colorNeutral: "#1c1917",
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif",
    borderRadius: "1rem",
  },
} as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  if (!authEnabled) return <>{children}</>;

  return (
    <ClerkProvider
      publishableKey={CLERK_PUBLISHABLE_KEY}
      appearance={appearance}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      afterSignOutUrl="/"
    >
      <TokenBridge />
      {children}
    </ClerkProvider>
  );
}

/** Publishes Clerk's token getter to the plain-fetch layer. */
function TokenBridge() {
  const { getToken } = useAuth();
  useEffect(() => {
    setTokenSource(() => getToken());
    return () => setTokenSource(null);
  }, [getToken]);
  return null;
}

/**
 * The gate in front of the dashboard.
 *
 * Sends a signed-out visitor to the sign-in page rather than showing them an
 * empty shell: every panel behind this point needs a session to load anything
 * at all, so a half-rendered dashboard would only be a slower 401.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  if (!authEnabled) return <>{children}</>;
  return <ClerkGate>{children}</ClerkGate>;
}

function ClerkGate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { redirectToSignIn } = useClerk();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      redirectToSignIn({ signInFallbackRedirectUrl: pathname });
    }
  }, [isLoaded, isSignedIn, pathname, redirectToSignIn]);

  if (!isLoaded) return <AuthSplash label="Checking your session…" />;
  if (!isSignedIn) return <AuthSplash label="Redirecting to sign in…" />;
  return <>{children}</>;
}

function AuthSplash({ label }: { label: string }) {
  return (
    <div className="grid min-h-[60vh] place-items-center">
      <div className="flex items-center gap-3 text-sm text-dim">
        <Spinner /> {label}
      </div>
    </div>
  );
}

/** The signed-in user's avatar menu, for the app header. */
export function UserMenu() {
  if (!authEnabled) {
    return <span className="text-xs text-dim">local operator</span>;
  }
  return (
    <UserButton
      appearance={{ elements: { avatarBox: { width: "2rem", height: "2rem" } } }}
      userProfileProps={{ appearance }}
    />
  );
}

/** The visitor's entry point, in the marketing header: sign in, or go straight in. */
export function HeaderAuthActions() {
  if (!authEnabled) {
    return <Link to="/app" className={buttonClass("primary", "sm")}>Open dashboard</Link>;
  }
  return <ClerkHeaderActions />;
}

function ClerkHeaderActions() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) return <div className="h-8 w-28 animate-pulse rounded-lg bg-raised/60" />;

  if (isSignedIn) {
    return (
      <div className="flex items-center gap-3">
        <Link to="/app" className={buttonClass("primary", "sm")}>Open dashboard</Link>
        <UserButton appearance={{ elements: { avatarBox: { width: "2rem", height: "2rem" } } }} />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <Link to="/sign-in" className={buttonClass("ghost", "sm")}>Sign in</Link>
      <Link to="/sign-up" className={buttonClass("primary", "sm")}>Get started</Link>
    </div>
  );
}

/**
 * Opens Clerk's account panel, which is where a GitHub connection is added.
 *
 * Returns null when Clerk is not in use, so the caller can fall back to the
 * server's connect URL instead of offering a button that does nothing.
 */
export function useOpenAccount(): (() => void) | null {
  // `authEnabled` is fixed at build time, so this branch never flips between
  // renders and the hook below is called consistently or not at all.
  if (!authEnabled) return null;
  return useClerkAccountOpener();
}

function useClerkAccountOpener() {
  const { openUserProfile } = useClerk();
  return () => openUserProfile({ appearance });
}
