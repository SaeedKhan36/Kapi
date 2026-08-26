/**
 * The browser half of authentication.
 *
 * Two things live here. First, whether authentication is on at all: a
 * single-operator kapi has no Clerk key, and mounting Clerk without one would
 * break the dashboard for exactly the people the zero-config quick start is
 * aimed at. Second, a bridge that lets non-React code - the fetch wrapper and
 * the websocket - reach the current session token, since Clerk only exposes it
 * through a hook.
 */

/**
 * Vite exposes `CLERK_PUBLISHABLE_KEY` here because `envPrefix` allows it by
 * name; the secret key never matches that prefix and so never ships. The
 * `VITE_` spelling is accepted too, for deployments that set it that way.
 */
export const CLERK_PUBLISHABLE_KEY: string | undefined =
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || import.meta.env.CLERK_PUBLISHABLE_KEY || undefined;

export const authEnabled = Boolean(CLERK_PUBLISHABLE_KEY);

type TokenSource = () => Promise<string | null>;

let source: TokenSource | null = null;

/** Called once by the provider, so the rest of the app need not know about React. */
export function setTokenSource(fn: TokenSource | null) {
  source = fn;
}

/**
 * The current session token, or undefined.
 *
 * Never throws: a failure to refresh should surface as a 401 from the API,
 * which the UI already knows how to explain, rather than as an exception from
 * whichever fetch happened to run first.
 */
export async function getAccessToken(): Promise<string | undefined> {
  if (!authEnabled || !source) return undefined;
  try {
    return (await source()) || undefined;
  } catch {
    return undefined;
  }
}

/** Authorization header for a request, when there is a session to send. */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}
