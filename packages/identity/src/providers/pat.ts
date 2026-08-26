import type { AuthorizationResult, GitIdentity, RepoAccess } from "../types.ts";

/**
 * The single-operator path: one personal access token, whatever it can reach.
 *
 * This is what `pnpm run:agent` and `pnpm smoke` use, and it keeps the
 * zero-configuration quick start honest - no WorkOS, no GitHub App, no
 * database of users. It authorizes everything, because there is no second
 * party whose consent could be checked: the person holding the token is the
 * person running the command.
 */
export class PatRepoAccess implements RepoAccess {
  readonly name = "pat";

  constructor(
    private token = process.env.GITHUB_TOKEN,
    private author: GitIdentity = {
      name: process.env.GIT_AUTHOR_NAME ?? "kapi-agent",
      email: process.env.GIT_AUTHOR_EMAIL ?? "agent@kapi.local",
    },
  ) {}

  /** The same token for every remote - that is exactly what makes a PAT risky. */
  async tokenFor(_repoUrl: string): Promise<string | undefined> {
    return this.token || undefined;
  }

  async apiToken(): Promise<string | undefined> {
    return this.token || undefined;
  }

  /**
   * Always allowed, and not restricted to GitHub: a PAT works against any git
   * remote, and there is no second party whose consent could be checked - the
   * person holding the token is the person running the command.
   *
   * A missing token is not an authorization failure either. A run without one
   * still plans and still works; its branches simply stay in the sandbox,
   * which is documented behaviour rather than an error.
   */
  async authorize(_repoUrl: string): Promise<AuthorizationResult> {
    return { ok: true };
  }

  async identity(): Promise<GitIdentity> {
    return this.author;
  }
}
