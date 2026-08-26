import { useEffect, useState } from "react";
import { api, ApiError, type Authorization, type Branch, type Repository } from "~/lib/api.ts";
import { Button, Input, Spinner } from "./ui.tsx";

export type RepoSelection = { repoUrl: string; baseBranch: string };

/**
 * Picks a repository the user can actually run against.
 *
 * A free-text clone URL cannot tell anyone whether kapi may touch it until a
 * run has already been started and refused. Listing what the user can see, and
 * checking authorization on selection, moves both failures - "you cannot push
 * here" and "the app is not installed" - to before the goal is written.
 *
 * Falls back to a plain URL field when the orchestrator has no GitHub
 * connection to offer, which is the single-operator case.
 */
export function RepoPicker({
  value,
  onChange,
  connectUrl,
}: {
  value: RepoSelection;
  onChange: (next: RepoSelection) => void;
  connectUrl?: string;
}) {
  const [repos, setRepos] = useState<Repository[] | null>(null);
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [selected, setSelected] = useState<Repository | null>(null);
  const [authorization, setAuthorization] = useState<Authorization | null>(null);
  const [needsConnect, setNeedsConnect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    api.listRepos()
      .then((r) => setRepos(r.repositories))
      .catch((err) => {
        if (err instanceof ApiError && err.code === "GITHUB_NOT_CONNECTED") setNeedsConnect(true);
        else setError(err instanceof Error ? err.message : String(err));
        setRepos([]);
      });
  }, []);

  const select = async (repo: Repository) => {
    setSelected(repo);
    setBranches(null);
    setAuthorization(null);
    onChange({ repoUrl: repo.cloneUrl, baseBranch: repo.defaultBranch });

    // Both in flight at once: neither answer depends on the other, and the
    // branch list is useless if the repository turns out to be off limits.
    const [branchResult, authResult] = await Promise.allSettled([
      api.listBranches(repo.owner, repo.name),
      api.authorization(repo.owner, repo.name),
    ]);

    if (branchResult.status === "fulfilled") setBranches(branchResult.value.branches);
    if (authResult.status === "fulfilled") setAuthorization(authResult.value);
  };

  if (needsConnect) {
    return (
      <div className="rounded-lg border border-line/60 bg-ink/40 p-4 text-sm">
        <p className="text-muted">Connect GitHub to choose a repository.</p>
        <a href={connectUrl ?? "/api/github/connect"}>
          <Button className="mt-3" type="button">Connect GitHub</Button>
        </a>
      </div>
    );
  }

  if (repos === null) {
    return <div className="flex items-center gap-2 py-2 text-sm text-muted"><Spinner /> Loading repositories…</div>;
  }

  // No listing available - fall back to what kapi has always accepted.
  if (repos.length === 0 && error) {
    return (
      <div className="space-y-2">
        <Input
          required
          placeholder="https://github.com/you/your-repo.git"
          value={value.repoUrl}
          onChange={(e) => onChange({ ...value, repoUrl: e.target.value })}
        />
        <p className="text-xs text-amber-400/80">{error}</p>
      </div>
    );
  }

  const visible = filter
    ? repos.filter((r) => r.fullName.toLowerCase().includes(filter.toLowerCase()))
    : repos;

  return (
    <div className="space-y-3">
      <Input
        placeholder="Filter repositories…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      <div className="max-h-52 overflow-y-auto rounded-lg border border-line/60">
        {visible.slice(0, 100).map((repo) => (
          <button
            key={repo.id}
            type="button"
            onClick={() => void select(repo)}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition hover:bg-line/20 ${
              selected?.id === repo.id ? "bg-line/30" : ""
            }`}
          >
            <span className="truncate">{repo.fullName}</span>
            {repo.private && <span className="text-[10px] uppercase text-muted">private</span>}
          </button>
        ))}
        {visible.length === 0 && (
          <p className="px-3 py-4 text-sm text-muted">No repositories match “{filter}”.</p>
        )}
      </div>

      {selected && (
        <div className="space-y-2">
          <label className="block text-xs text-muted">Base branch</label>
          {branches === null ? (
            <div className="flex items-center gap-2 text-sm text-muted"><Spinner /> Loading branches…</div>
          ) : (
            <select
              value={value.baseBranch}
              onChange={(e) => onChange({ ...value, baseBranch: e.target.value })}
              className="w-full rounded-lg border border-line/60 bg-ink/60 px-3 py-2 text-sm"
            >
              {branches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}{b.protected ? " (protected)" : ""}
                </option>
              ))}
            </select>
          )}

          {authorization && !authorization.ok && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <p className="text-amber-200">{authorization.reason}</p>
              {authorization.installUrl && (
                <a
                  href={authorization.installUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-xs font-medium text-amber-300 underline"
                >
                  {authorization.action === "configure"
                    ? "Add this repository to the kapi app →"
                    : "Install the kapi app →"}
                </a>
              )}
            </div>
          )}

          {authorization?.ok && (
            <p className="text-xs text-emerald-400/80">kapi can push to this repository.</p>
          )}
        </div>
      )}
    </div>
  );
}
