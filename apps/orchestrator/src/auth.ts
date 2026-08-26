import type { Context, MiddlewareHandler, Next } from "hono";
import {
  ClerkAuth, IdentityError, WorkOSAuth, readClerkConfig, readWorkOSConfig,
  type SessionProvider, type SessionUser,
} from "@kapi/identity";
import type { Store } from "./store.ts";

/**
 * Who is calling.
 *
 * Kapi has two legitimate deployment shapes and this module refuses to pretend
 * otherwise. Run it yourself with a PAT and there is exactly one user, so
 * demanding a login would be theatre - the README promises a working system
 * with nothing but a Gemini key. Run it for other people and every request
 * must carry a verified session, because a run spends money and touches
 * someone's repository.
 *
 * `KAPI_AUTH_MODE` picks, and defaults to whichever the configuration implies.
 * Clerk wins a tie because it is what the dashboard ships with; WorkOS stays
 * supported for deployments already on it.
 */
export type AuthMode = "clerk" | "workos" | "none";

/** The fixed identity used in single-operator mode, so runs still have an owner. */
export const LOCAL_USER: SessionUser = {
  id: "local",
  email: process.env.GIT_AUTHOR_EMAIL ?? "agent@kapi.local",
  name: process.env.GIT_AUTHOR_NAME ?? "Local operator",
};

export function authMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  const explicit = env.KAPI_AUTH_MODE?.trim().toLowerCase();
  if (explicit === "clerk" || explicit === "workos" || explicit === "none") return explicit;
  // Configuring a provider is a deliberate act; take it as the intent to use it.
  if (readClerkConfig(env)) return "clerk";
  return readWorkOSConfig(env) ? "workos" : "none";
}

export type AuthedEnv = { Variables: { user: SessionUser } };

export class AuthError extends Error {
  constructor(message: string, readonly status = 401, readonly code = "UNAUTHENTICATED") {
    super(message);
    this.name = "AuthError";
  }
}

/** Pulls the access token from the Authorization header, or the websocket's query. */
export function bearerFrom(c: Context): string | undefined {
  const header = c.req.header("authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7).trim() || undefined;
  return undefined;
}

/** Builds the configured session provider, or null in single-operator mode. */
function providerFor(mode: AuthMode): SessionProvider | null {
  if (mode === "clerk") {
    const config = readClerkConfig();
    if (!config) {
      throw new Error(
        "KAPI_AUTH_MODE=clerk but CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY are not set",
      );
    }
    return new ClerkAuth(config);
  }
  if (mode === "workos") {
    const config = readWorkOSConfig();
    if (!config) {
      throw new Error(
        "KAPI_AUTH_MODE=workos but WORKOS_CLIENT_ID and WORKOS_API_KEY are not set",
      );
    }
    return new WorkOSAuth(config);
  }
  return null;
}

/**
 * Verifies the caller and puts them on the context.
 *
 * In `none` mode this still runs and still sets a user - the rest of the code
 * then has exactly one path to reason about, rather than a nullable user that
 * every handler has to remember to check.
 */
export function createAuth(store: Store, mode: AuthMode = authMode()) {
  const identity = providerFor(mode);

  /** Resolves a raw access token to a user, or throws. Shared with the websocket. */
  const authenticate = async (token: string | undefined): Promise<SessionUser> => {
    if (!identity) {
      await store.upsertUser(LOCAL_USER);
      return LOCAL_USER;
    }
    if (!token) throw new AuthError("sign in to continue");

    let user: SessionUser;
    try {
      user = await identity.verify(token);
    } catch (err) {
      throw err instanceof IdentityError
        ? new AuthError(err.message, err.status, err.code ?? "UNAUTHENTICATED")
        : new AuthError("sign in to continue");
    }

    // The token may carry only a subject; the profile is worth one call so runs
    // can be attributed to a name rather than an opaque id.
    const profile = user.email && user.name
      ? user
      : await identity.getUser(user.id).catch(() => user);
    const resolved = { ...user, ...profile, id: user.id };
    await store.upsertUser({
      id: resolved.id,
      email: resolved.email,
      name: resolved.name,
      organizationId: user.organizationId,
    });
    return resolved;
  };

  const middleware: MiddlewareHandler<AuthedEnv> = async (c, next: Next) => {
    try {
      c.set("user", await authenticate(bearerFrom(c)));
    } catch (err) {
      const e = err instanceof AuthError ? err : new AuthError("sign in to continue");
      return c.json({ error: e.message, code: e.code }, e.status as 401);
    }
    await next();
  };

  return { mode, identity, authenticate, middleware };
}

export type Auth = ReturnType<typeof createAuth>;
