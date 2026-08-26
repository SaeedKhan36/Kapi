import { createRemoteJWKSet, jwtVerify } from "jose";
import { IdentityError, type SessionProvider, type SessionUser } from "./session.ts";

/**
 * Clerk, reduced to the two things the orchestrator needs: verifying a session
 * token the browser sent, and borrowing the user's GitHub grant.
 *
 * Kapi never stores a GitHub OAuth token. Clerk holds the grant and refreshes
 * it; `githubTokenFor` asks for a live one per request. A database that never
 * holds a long-lived third-party credential cannot leak one.
 */
const CLERK_API = "https://api.clerk.com/v1";

export class ClerkError extends IdentityError {
  constructor(message: string, status = 500, code?: string) {
    super(message, status, code);
    this.name = "ClerkError";
  }
}

export type ClerkConfig = {
  secretKey: string;
  publishableKey: string;
  /** The instance's Frontend API origin, which is also the token issuer. */
  issuer: string;
};

/**
 * Clerk's publishable key is the base64 of its Frontend API host with a `$`
 * terminator - `pk_test_ZXF1YWwt…` decodes to `equal-warthog-32.clerk.accounts.dev$`.
 * Deriving the issuer from it means a deployment configures two keys, not four,
 * and the issuer can never drift out of sync with the instance.
 */
export function issuerFromPublishableKey(publishableKey: string): string | null {
  const encoded = publishableKey.replace(/^pk_(test|live)_/, "");
  if (encoded === publishableKey) return null;
  try {
    const host = Buffer.from(encoded, "base64").toString("utf8").replace(/\$+$/, "");
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? `https://${host}` : null;
  } catch {
    return null;
  }
}

export function readClerkConfig(env: NodeJS.ProcessEnv = process.env): ClerkConfig | null {
  const secretKey = env.CLERK_SECRET_KEY?.trim();
  const publishableKey = env.CLERK_PUBLISHABLE_KEY?.trim();
  if (!secretKey || !publishableKey) return null;

  const issuer = env.CLERK_ISSUER?.trim() || issuerFromPublishableKey(publishableKey);
  if (!issuer) return null;

  return { secretKey, publishableKey, issuer };
}

type ClerkUser = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  image_url?: string | null;
  username?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: Array<{ id: string; email_address: string }>;
};

const nameOf = (user: ClerkUser) =>
  [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || undefined;

const emailOf = (user: ClerkUser) => {
  const list = user.email_addresses ?? [];
  const primary = list.find((e) => e.id === user.primary_email_address_id) ?? list[0];
  return primary?.email_address;
};

export class ClerkAuth implements SessionProvider {
  readonly name = "clerk";

  #jwks: ReturnType<typeof createRemoteJWKSet>;
  #verified = new Map<string, { user: SessionUser; expiresAt: number }>();

  constructor(private config: ClerkConfig) {
    this.#jwks = createRemoteJWKSet(new URL(`${config.issuer}/.well-known/jwks.json`));
  }

  /**
   * Verifies a session token against Clerk's published keys.
   *
   * Cached for at most a minute, and never past the token's own expiry, so a
   * revoked session stops working promptly while a burst of dashboard polling
   * does not mean a JWKS round trip each time.
   */
  async verify(accessToken: string): Promise<SessionUser> {
    const cached = this.#verified.get(accessToken);
    if (cached && cached.expiresAt > Date.now()) return cached.user;

    let payload;
    try {
      ({ payload } = await jwtVerify(accessToken, this.#jwks, {
        issuer: this.config.issuer,
        // Clerk mints short-lived tokens (60s) and refreshes them in the
        // browser; a little tolerance keeps a slow clock from reading as a
        // forged token.
        clockTolerance: 30,
      }));
    } catch {
      throw new ClerkError("invalid or expired session", 401, "UNAUTHENTICATED");
    }

    if (typeof payload.sub !== "string") {
      throw new ClerkError("session token has no subject", 401, "UNAUTHENTICATED");
    }

    // Claims Clerk can be configured to include. Using them avoids a Backend
    // API round trip for the common case of "show me my own name".
    const user: SessionUser = {
      id: payload.sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
      name: typeof payload.name === "string" ? payload.name : undefined,
    };

    this.#verified.set(accessToken, {
      user,
      expiresAt: Math.min(
        typeof payload.exp === "number" ? payload.exp * 1000 : Date.now() + 60_000,
        Date.now() + 60_000,
      ),
    });
    // Bounded so a long-lived process cannot accumulate tokens indefinitely.
    if (this.#verified.size > 500) {
      const oldest = this.#verified.keys().next().value;
      if (typeof oldest === "string") this.#verified.delete(oldest);
    }

    return user;
  }

  async getUser(userId: string): Promise<SessionUser> {
    const user = await this.#api<ClerkUser>(`/users/${encodeURIComponent(userId)}`);
    return {
      id: user.id,
      email: emailOf(user),
      name: nameOf(user),
      avatarUrl: user.image_url ?? undefined,
    };
  }

  async #api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${CLERK_API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.config.secretKey}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const body = await res.text();
    if (!res.ok) {
      let detail = body.slice(0, 300);
      try {
        const parsed = JSON.parse(body);
        detail = parsed.errors?.[0]?.long_message ?? parsed.errors?.[0]?.message ?? detail;
      } catch { /* keep raw */ }
      throw new ClerkError(`Clerk ${res.status} on ${path}: ${detail}`, res.status);
    }
    return (body ? JSON.parse(body) : {}) as T;
  }

  // ------------------------------------------------------- GitHub connection

  /**
   * The user's live GitHub OAuth token, held and refreshed by Clerk.
   *
   * Clerk renamed this endpoint's provider segment from `oauth_github` to
   * `github`; both shapes are still served depending on instance age, so try
   * the current one and fall back rather than making the deployment care.
   */
  async githubTokenFor(userId: string): Promise<string> {
    const path = `/users/${encodeURIComponent(userId)}/oauth_access_tokens`;
    type Grant = { token?: string; scopes?: string[]; provider?: string };

    let grants: Grant[] = [];
    try {
      grants = await this.#list<Grant>(`${path}/github`);
    } catch (err) {
      if (err instanceof ClerkError && (err.status === 404 || err.status === 422)) {
        grants = await this.#list<Grant>(`${path}/oauth_github`).catch(() => []);
      } else {
        throw err;
      }
    }

    const token = grants.find((g) => g.token)?.token;
    if (!token) {
      throw new ClerkError(
        "Connect GitHub to continue.",
        401,
        "GITHUB_NOT_CONNECTED",
      );
    }
    return token;
  }

  /** Clerk answers either a bare array or `{ data: [...] }` depending on version. */
  async #list<T>(path: string): Promise<T[]> {
    const body = await this.#api<T[] | { data?: T[] }>(path);
    return Array.isArray(body) ? body : body.data ?? [];
  }

  async isGithubConnected(userId: string): Promise<boolean> {
    try {
      await this.githubTokenFor(userId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Null on purpose: Clerk connects GitHub from its own account UI, which the
   * dashboard opens in place. There is no server-side URL to redirect to, and
   * inventing one would send the user somewhere that cannot complete the flow.
   */
  async githubAuthorizationUrl(): Promise<string | null> {
    return null;
  }
}
