import { canPush, githubUserIdentity } from "../github-api.ts";
import { GitHubApp, GitHubAppError, type GitHubAppConfig } from "../github-app.ts";
import type { AuthorizationResult, GitIdentity, RepoAccess, RepoRef } from "../types.ts";
import { parseRepoUrl, repoFullName } from "../types.ts";

export type GitHubAppUser = {
  /** The user's live GitHub OAuth token, resolved per run by the caller. */
  oauthToken: string;
  /** Fallbacks for commit authorship when GitHub keeps the address private. */
  profile?: { name?: string | null; email?: string | null };
};

/**
 * The multi-user path, and the reason the two token types exist.
 *
 * `apiToken` is the human's OAuth token: broad, used only inside the
 * orchestrator, and what a pull request gets attributed to. `tokenFor` is a
 * GitHub App installation token: one repository, `contents` only, an hour
 * long, and the only credential that is ever allowed into a sandbox.
 *
 * `authorize` requires both parties to have said yes - the repo owner by
 * installing the App, and the user by actually having push rights. Either
 * alone is not enough.
 */
export class GitHubAppRepoAccess implements RepoAccess {
  readonly name = "github-app";

  #app: GitHubApp;
  #identity: Promise<GitIdentity & { username: string }> | undefined;

  constructor(config: GitHubAppConfig, private user: GitHubAppUser) {
    this.#app = new GitHubApp(config);
  }

  async apiToken(): Promise<string | undefined> {
    return this.user.oauthToken;
  }

  async tokenFor(repoUrl: string): Promise<string | undefined> {
    const ref = parseRepoUrl(repoUrl);
    if (!ref) throw new GitHubAppError(`${repoUrl} is not a GitHub repository`);
    return this.#app.tokenFor(ref);
  }

  async identity(): Promise<GitIdentity> {
    this.#identity ??= githubUserIdentity(this.user.oauthToken, this.user.profile ?? {});
    const { name, email } = await this.#identity;
    return { name, email };
  }

  async authorize(repoUrl: string): Promise<AuthorizationResult> {
    const ref = parseRepoUrl(repoUrl);
    if (!ref) {
      return {
        ok: false,
        action: "denied",
        reason: `${repoUrl} is not a GitHub repository, and the Kapi GitHub App can only reach GitHub.`,
      };
    }

    // The user's own rights first: it is the cheaper check, and a user who
    // cannot push should get "you cannot push here" rather than an invitation
    // to install an App on someone else's repository.
    let username: string;
    try {
      username = (await this.#whoami()).username;
    } catch (err) {
      return {
        ok: false,
        action: "connect",
        reason: err instanceof Error ? err.message : "Could not identify your GitHub account.",
      };
    }

    if (!await canPush(this.user.oauthToken, ref, username)) {
      return {
        ok: false,
        action: "denied",
        reason: `Your GitHub account (${username}) cannot push to ${repoFullName(ref)}.`,
      };
    }

    // Then the owner's consent, expressed as an App installation.
    try {
      const status = await this.#app.installationStatus(ref);
      return status.installed
        ? { ok: true }
        : { ok: false, reason: status.reason, installUrl: status.installUrl, action: status.action };
    } catch (err) {
      if (err instanceof GitHubAppError) {
        return { ok: false, reason: err.message, installUrl: err.installUrl, action: "install" };
      }
      throw err;
    }
  }

  #whoami() {
    this.#identity ??= githubUserIdentity(this.user.oauthToken, this.user.profile ?? {});
    return this.#identity;
  }

  /** Drops any cached installation token for this run. */
  forget(ref?: RepoRef) {
    this.#app.forget(ref);
  }
}
