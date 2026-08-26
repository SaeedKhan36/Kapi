/**
 * Minimal GitHub REST client for the bits of the run that touch the remote.
 *
 * Deliberately fetch-based rather than shelling out to `gh`: the orchestrator
 * always has network, sandboxes may not have the CLI installed, and this keeps
 * the token out of the sandbox environment entirely.
 */
export type RepoRef = { owner: string; repo: string };

export function parseRepoUrl(url: string): RepoRef | null {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

async function gh<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body = await res.text();
  if (!res.ok) {
    let message = body.slice(0, 300);
    try { message = JSON.parse(body).message ?? message; } catch { /* keep raw */ }
    throw new Error(`GitHub ${res.status} on ${path}: ${message}`);
  }
  return (body ? JSON.parse(body) : {}) as T;
}

export type PullRequest = { number: number; html_url: string };

/**
 * Opens a PR, or returns the existing one if a PR for this head is already
 * open — reruns against the same branch should be idempotent, not an error.
 */
export async function openPullRequest(
  token: string,
  ref: RepoRef,
  opts: { head: string; base: string; title: string; body: string },
): Promise<PullRequest> {
  try {
    return await gh<PullRequest>(`/repos/${ref.owner}/${ref.repo}/pulls`, token, {
      method: "POST",
      body: JSON.stringify(opts),
    });
  } catch (err) {
    const existing = await gh<PullRequest[]>(
      `/repos/${ref.owner}/${ref.repo}/pulls?head=${ref.owner}:${opts.head}&state=open`,
      token,
    ).catch(() => []);
    if (existing.length > 0) return existing[0];
    throw err;
  }
}

export async function branchExists(token: string, ref: RepoRef, branch: string): Promise<boolean> {
  try {
    await gh(`/repos/${ref.owner}/${ref.repo}/branches/${encodeURIComponent(branch)}`, token);
    return true;
  } catch {
    return false;
  }
}
