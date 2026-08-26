/**
 * Who is running, and what they are allowed to touch.
 *
 * Kapi's other capabilities sit behind interfaces with more than one
 * implementation so no vendor is load-bearing; credentials are no different.
 * The run engine asks a `RepoAccess` for a token instead of reading
 * `process.env.GITHUB_TOKEN`, which is what lets a single operator's PAT and a
 * multi-user GitHub App coexist without the engine knowing the difference.
 */
export type RepoRef = { owner: string; repo: string };

export const repoFullName = (ref: RepoRef) => `${ref.owner}/${ref.repo}`;

/** Parses the GitHub repo out of a clone URL. Null for anything not GitHub. */
export function parseRepoUrl(url: string): RepoRef | null {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * The outcome of asking whether this repository may be worked on.
 *
 * A refusal is a returned value rather than a thrown error because "the app is
 * not installed yet" is a normal UI state with an actionable next step, not a
 * failure - the caller needs `installUrl` to send the user somewhere useful.
 */
export type AuthorizationAction = "install" | "configure" | "connect" | "denied";

export type AuthorizationResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      /** Where to send the user to fix it, when that is a meaningful action. */
      installUrl?: string;
      action?: AuthorizationAction;
    };

export type GitIdentity = { name: string; email: string };

export interface RepoAccess {
  /** "pat" | "github-app". Surfaced in /api/health and run metadata. */
  readonly name: string;

  /**
   * A credential good for git operations on exactly this repo.
   *
   * Called per git operation rather than once per run: installation tokens
   * expire in an hour, and a run may outlive that. Implementations cache.
   * Undefined means "no push access configured" - the run still completes,
   * branches just stay local to their sandbox.
   */
  tokenFor(ref: RepoRef): Promise<string | undefined>;

  /**
   * Whether work may proceed on this repo at all. Checked once, before any
   * sandbox is created, so an unauthorized run costs nothing.
   */
  authorize(ref: RepoRef): Promise<AuthorizationResult>;

  /** Commit author for work produced by this run. */
  identity(): Promise<GitIdentity>;

  /**
   * Credential for GitHub REST calls that should be attributed to the human -
   * opening a pull request, most importantly. Distinct from `tokenFor`, which
   * is machine-scoped and must never leave the orchestrator's control except
   * as an ephemeral file inside one sandbox.
   */
  apiToken(): Promise<string | undefined>;
}

export class RepoAccessError extends Error {
  constructor(
    message: string,
    readonly action?: AuthorizationAction,
    readonly installUrl?: string,
  ) {
    super(message);
    this.name = "RepoAccessError";
  }
}
