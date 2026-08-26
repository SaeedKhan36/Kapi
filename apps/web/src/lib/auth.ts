/**
 * The browser half of authentication.
 *
 * Two things live here. First, whether authentication is on at all: a
 * single-operator kapi has no WorkOS client id, and mounting AuthKit without
 * one would break the dashboard for exactly the people the zero-config quick
 * start is aimed at. Second, a bridge that lets non-React code - the fetch
 * wrapper and the websocket - reach the current access token, since AuthKit
 * only exposes it through a hook.
 */
export const WORKOS_CLIENT_ID: string | undefined =
  import.meta.env.VITE_WORKOS_CLIENT_ID || undefined;

export const authEnabled = Boolean(WORKOS_CLIENT_ID);

export const redirectUri: string =
  import.meta.env.VITE_WORKOS_REDIRECT_URI ||
  (typeof location !== "undefined" ? `${location.origin}/callback` : "");

type TokenSource = () => Promise<string | undefined>;

let source: TokenSource | null = null;

/** Called once by the provider, so the rest of the app need not know about React. */
export function setTokenSource(fn: TokenSource | null) {
  source = fn;
}

/**
 * The current access token, or undefined.
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
