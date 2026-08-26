import { readAppConfig } from "./github-app.ts";
import { GitHubAppRepoAccess, type GitHubAppUser } from "./providers/github-app.ts";
import { PatRepoAccess } from "./providers/pat.ts";
import type { RepoAccess } from "./types.ts";

export * from "./types.ts";
export * from "./github-api.ts";
export * from "./github-app.ts";
export * from "./session.ts";
export * from "./workos.ts";
export * from "./clerk.ts";
export { PatRepoAccess, GitHubAppRepoAccess };
export type { GitHubAppUser };

/**
 * Picks how this run gets at GitHub.
 *
 * With a `user` the App path is used, so the sandbox only ever sees a
 * single-repository token. Without one - the CLI, the smoke test, a
 * single-operator deployment - it falls back to the PAT, which is what Kapi
 * did before any of this existed.
 */
export function createRepoAccess(user?: GitHubAppUser): RepoAccess {
  const app = readAppConfig();
  if (user && app) return new GitHubAppRepoAccess(app, user);
  return new PatRepoAccess();
}

/** True when a GitHub App is configured, so the API can advertise the multi-user flow. */
export const githubAppConfigured = () => readAppConfig() !== null;
