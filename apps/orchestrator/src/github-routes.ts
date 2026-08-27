import {
  createRepoAccess, readAppConfig, GitHubAppRepoAccess, IdentityError,
  type RepoAccess, type SessionUser,
} from "@kapi/identity";
import type { Auth } from "./auth.ts";

/**
 * Builds the credential chain for one request.
 *
 * This is the join between the two halves of the system: the login provider
 * knows who the user is and holds their GitHub grant, the GitHub App knows
 * which repositories their owners have opened to Kapi. Only when both agree
 * does a run get a token, and even then only one scoped to a single repository.
 *
 * Single-operator (no login provider) still uses the PAT. A signed-in
 * deployment must not: falling back would let any session spend the operator
 * token against the operator's repositories.
 */
export async function repoAccessFor(auth: Auth, user: SessionUser): Promise<RepoAccess> {
  if (!auth.identity) return createRepoAccess();

  const app = readAppConfig();
  if (!app) {
    throw new IdentityError(
      "Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY. Multi-user mode cannot use the operator PAT.",
      503,
      "GITHUB_APP_NOT_CONFIGURED",
    );
  }

  // The human's own credential. Never reaches a sandbox - it is here to prove
  // they could have pushed themselves, and to attribute the pull request.
  const oauthToken = await auth.identity.githubTokenFor(user.id, user.organizationId);

  return new GitHubAppRepoAccess(app, {
    oauthToken,
    profile: { name: user.name, email: user.email },
  });
}

export { PatRepoAccess } from "@kapi/identity";
