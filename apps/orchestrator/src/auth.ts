import type { Context, MiddlewareHandler, Next } from "hono";
import { WorkOSAuth, WorkOSError, readWorkOSConfig, type WorkOSUser } from "@kapi/identity";
import type { Store } from "./store.ts";

/**
 * Who is calling.
 *
 * Kapi has two legitimate deployment shapes and this module refuses to pretend
 * otherwise. Run it yourself with a PAT and there is exactly one user, so
 * demanding a login would be theatre - the README promises a working system
 * with nothing but a Gemini key. Run it for other people and every request
 * must carry a verified WorkOS session, because a run spends money and touches
 * someone's repository.
 *
 * `KAPI_AUTH_MODE` picks, and defaults to whichever the configuration implies.
 */
export type AuthMode = "workos" | "none";

/** The fixed identity used in single-operator mode, so runs still have an owner. */
export const LOCAL_USER: WorkOSUser = {
  id: "local",
  email: process.env.GIT_AUTHOR_EMAIL ?? "agent@kapi.local",
  name: process.env.GIT_AUTHOR_NAME ?? "Local operator",
};

export function authMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  const explicit = env.KAPI_AUTH_MODE?.trim().toLowerCase();
  if (explicit === "workos" || explicit === "none") return explicit;
  // Configuring WorkOS is a deliberate act; take it as the intent to use it.
  return readWorkOSConfig(env) ? "workos" : "none";
}

export type AuthedEnv = { Variables: { user: WorkOSUser } };

/**
 * Whether a caller may choose this sandbox provider.
 *
 * `local` runs agent commands as ordinary host processes - it exists for
 * developing orchestration logic and says so in its own docstring. Letting a
 * request select it grants code execution on the orchestrator, which is a much
 * larger thing than "may start a run". With one operator that is exactly the
 * intended use; with more than one it is a privilege escalation, so the
 * provider becomes a deployment decision rather than a request parameter.
 */
export function providerAllowed(mode: AuthMode, providerName?: string): boolean {
  if (mode === "none") return true;
  return providerName !== "local";
}

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

/**
 * Verifies the caller and puts them on the context.
 *
 * In `none` mode this still runs and still sets a user - the rest of the code
 * then has exactly one path to reason about, rather than a nullable user that
 * every handler has to remember to check.
 */
export function createAuth(store: Store, mode: AuthMode = authMode()) {
  const config = mode === "workos" ? readWorkOSConfig() : null;
  if (mode === "workos" && !config) {
    throw new Error(
      "KAPI_AUTH_MODE=workos but WORKOS_CLIENT_ID and WORKOS_API_KEY are not set",
    );
  }
  const workos = config ? new WorkOSAuth(config) : null;

  /** Resolves a raw access token to a user, or throws. Shared with the websocket. */
  const authenticate = async (token: string | undefined): Promise<WorkOSUser> => {
    if (!workos) {
      await store.upsertUser(LOCAL_USER);
      return LOCAL_USER;
    }
    if (!token) throw new AuthError("sign in to continue");

    let user: WorkOSUser;
    try {
      user = await workos.verify(token);
    } catch (err) {
      throw err instanceof WorkOSError
        ? new AuthError(err.message, err.status, err.code ?? "UNAUTHENTICATED")
        : new AuthError("sign in to continue");
    }

    // The token carries only a subject; the profile is worth one call so runs
    // can be attributed to a name rather than an opaque id.
    const profile = await workos.getUser(user.id).catch(() => user);
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

  return { mode, workos, authenticate, middleware };
}

export type Auth = ReturnType<typeof createAuth>;
