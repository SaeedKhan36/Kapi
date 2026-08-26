import {
  createRepoAccess, readAppConfig, GitHubAppRepoAccess, PatRepoAccess,
  type RepoAccess, type WorkOSUser,
} from "@kapi/identity";
import type { Auth } from "./auth.ts";

/**
 * Builds the credential chain for one request.
 *
 * This is the join between the two halves of the system: WorkOS knows who the
 * user is and holds their GitHub grant, the GitHub App knows which
 * repositories their owners have opened to Kapi. Only when both agree does a
 * run get a token, and even then only one scoped to a single repository.
 *
 * Without WorkOS or without an App configured this degrades to the PAT, which
 * is what a single-operator deployment wants and what the CLI already uses.
 */
export async function repoAccessFor(auth: Auth, user: WorkOSUser): Promise<RepoAccess> {
  const app = readAppConfig();
  if (!auth.workos || !app) return createRepoAccess();

  // The human's own credential. Never reaches a sandbox - it is here to prove
  // they could have pushed themselves, and to attribute the pull request.
  const oauthToken = await auth.workos.githubTokenFor(user.id, user.organizationId);

  return new GitHubAppRepoAccess(app, {
    oauthToken,
    profile: { name: user.name, email: user.email },
  });
}

export { PatRepoAccess };
