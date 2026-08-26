/**
 * Who is signed in.
 *
 * Kapi keeps every vendor behind an interface with more than one
 * implementation, and the login provider is no exception: Clerk and WorkOS
 * both answer the same three questions - is this token real, who does it
 * belong to, and may we borrow their GitHub grant - so the orchestrator never
 * learns which one is deployed.
 */
export type SessionUser = {
  id: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  /** Only WorkOS organizations populate this; Clerk leaves it undefined. */
  organizationId?: string;
};

/** A failure the API can hand back to the browser verbatim. */
export class IdentityError extends Error {
  constructor(message: string, readonly status = 500, readonly code?: string) {
    super(message);
    this.name = "IdentityError";
  }
}

export interface SessionProvider {
  /** "clerk" | "workos". Surfaced in /api/health so the UI knows what to mount. */
  readonly name: string;

  /** Verifies an access token the browser sent. Throws `IdentityError` on refusal. */
  verify(accessToken: string): Promise<SessionUser>;

  /** Full profile, for attributing runs to a name rather than an opaque id. */
  getUser(userId: string): Promise<SessionUser>;

  /**
   * The user's live GitHub OAuth token, held and refreshed by the provider.
   *
   * This is the *human's* credential: it lists repositories and proves they
   * could have pushed themselves. It never enters a sandbox, and Kapi never
   * stores it.
   */
  githubTokenFor(userId: string, organizationId?: string): Promise<string>;

  /** True when the user has a usable GitHub grant, without surfacing the token. */
  isGithubConnected(userId: string, organizationId?: string): Promise<boolean>;

  /**
   * Where to send the browser to start (or repair) the GitHub connection, or
   * null when the provider handles it in its own client-side UI - which is
   * what Clerk does, and why this is nullable rather than throwing.
   */
  githubAuthorizationUrl(opts: {
    userId: string;
    organizationId?: string;
    returnTo?: string;
  }): Promise<string | null>;
}
