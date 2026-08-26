import { AuthKitProvider, useAuth } from "@workos-inc/authkit-react";
import { useEffect, useState, type ReactNode } from "react";
import { authEnabled, redirectUri, setTokenSource, WORKOS_CLIENT_ID } from "~/lib/auth.ts";
import { Button, Card, Spinner } from "./ui.tsx";

/**
 * Wraps the app in a WorkOS session, when there is one to have.
 *
 * With no client id configured this renders its children untouched, which is
 * the single-operator path: kapi is meant to work with nothing but a Gemini
 * key, and a login screen in front of a one-person deployment is friction
 * without a purpose.
 *
 * AuthKit is browser-only, so the provider mounts after hydration. The server
 * renders the same children it would render while loading.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  if (!authEnabled) return <>{children}</>;
  if (!hydrated) return <Loading />;

  return (
    <AuthKitProvider clientId={WORKOS_CLIENT_ID!} redirectUri={redirectUri}>
      <TokenBridge />
      <SignedIn>{children}</SignedIn>
    </AuthKitProvider>
  );
}

/** Publishes AuthKit's token getter to the plain-fetch layer. */
function TokenBridge() {
  const { getAccessToken } = useAuth();
  useEffect(() => {
    setTokenSource(() => getAccessToken());
    return () => setTokenSource(null);
  }, [getAccessToken]);
  return null;
}

function SignedIn({ children }: { children: ReactNode }) {
  const { isLoading, user, signIn } = useAuth();

  if (isLoading) return <Loading />;
  if (user) return <>{children}</>;

  return (
    <div className="mx-auto max-w-md px-6 py-24">
      <Card className="p-8 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Sign in to kapi</h1>
        <p className="mt-2 text-sm text-muted">
          Runs clone your repositories and push branches, so kapi needs to know who you are
          before it can do either.
        </p>
        <Button className="mt-6 w-full" onClick={() => signIn()}>Sign in</Button>
      </Card>
    </div>
  );
}

function Loading() {
  return (
    <div className="grid place-items-center py-24 text-muted">
      <Spinner />
    </div>
  );
}

/** The signed-in user's chip, for the header. Renders nothing without auth. */
export function UserChip() {
  if (!authEnabled) return null;
  return <UserChipInner />;
}

function UserChipInner() {
  const { user, signOut } = useAuth();
  if (!user) return null;

  const label = user.firstName
    ? [user.firstName, user.lastName].filter(Boolean).join(" ")
    : user.email;

  return (
    <div className="ml-auto flex items-center gap-3">
      <span className="text-xs text-muted">{label}</span>
      <button
        onClick={() => signOut()}
        className="rounded-md border border-line/60 px-2 py-1 text-xs text-muted transition hover:text-fg"
      >
        Sign out
      </button>
    </div>
  );
}
