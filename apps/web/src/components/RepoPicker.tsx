import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Lock, Search } from "lucide-react";
import { api, ApiError, type Authorization, type Branch, type Repository } from "~/lib/api.ts";
import { cn } from "~/lib/cn.ts";
import { useOpenAccount } from "./auth.tsx";
import { Button, Input, Notice, Select, Spinner } from "./ui.tsx";

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
  const [open, setOpen] = useState(false);
  const openAccount = useOpenAccount();
  const wrapper = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.listRepos()
      .then((r) => setRepos(r.repositories))
      .catch((err) => {
        if (err instanceof ApiError && err.code === "GITHUB_NOT_CONNECTED") setNeedsConnect(true);
        else setError(err instanceof Error ? err.message : String(err));
        setRepos([]);
      });
  }, []);

  // An open list covers the rest of the form, so anything that means "I am
  // done here" - a click elsewhere, Escape - has to put it away.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) search.current?.focus();
    else setFilter("");
  }, [open]);

  const select = async (repo: Repository) => {
    setSelected(repo);
    setBranches(null);
    setAuthorization(null);
    setOpen(false);
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
      <div className="rounded-2xl border-[1.5px] border-line bg-[#e0f2fe] p-5 text-center shadow-[3px_3px_0_#1c1917]">
        <p className="text-sm text-muted">Connect GitHub to choose a repository.</p>
        {/* Clerk collects the grant in its own account panel; WorkOS hands back
            a URL to redirect to. Offer whichever this deployment has. */}
        {openAccount ? (
          <Button type="button" className="mt-3" onClick={openAccount}>Connect GitHub</Button>
        ) : (
          <a href={connectUrl ?? "/api/github/connect"} className="mt-3 inline-block">
            <Button type="button">Connect GitHub</Button>
          </a>
        )}
      </div>
    );
  }

  if (repos === null) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border-[1.5px] border-line bg-white px-3 py-3 text-sm text-dim">
        <Spinner /> Loading repositories…
      </div>
    );
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
        <p className="text-xs text-warn/90">{error}</p>
      </div>
    );
  }

  const visible = filter
    ? repos.filter((r) => r.fullName.toLowerCase().includes(filter.toLowerCase()))
    : repos;

  return (
    <div className="space-y-3">
      <div ref={wrapper} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn(
            "flex h-10 w-full cursor-pointer items-center gap-2 rounded-xl border-[1.5px] border-line px-3 text-left text-sm",
            "transition-colors hover:bg-white",
            open ? "bg-white shadow-[3px_3px_0_#1c1917]" : "bg-well",
          )}
        >
          {selected ? (
            <span className="truncate text-bright">
              <span className="text-dim">{selected.owner}/</span>
              <span className="font-medium">{selected.name}</span>
            </span>
          ) : (
            <span className="text-dim/80">Choose a repository…</span>
          )}
          {selected?.private && <Lock className="size-3 shrink-0 text-dim" />}
          <ChevronDown
            className={cn("ml-auto size-4 shrink-0 text-dim transition-transform", open && "rotate-180")}
          />
        </button>

        {open && (
          <div className="absolute left-0 right-0 top-full z-20 mt-2 space-y-2 rounded-2xl border-[1.5px] border-line bg-white p-2 shadow-[4px_4px_0_#1c1917]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-dim" />
              <Input
                ref={search}
                className="pl-9"
                placeholder="Search repositories…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>

            <div
              role="listbox"
              className="max-h-56 divide-y divide-line/20 overflow-y-auto rounded-xl border-[1.5px] border-line"
            >
              {visible.slice(0, 100).map((repo) => {
                const active = selected?.id === repo.id;
                return (
                  <button
                    key={repo.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => void select(repo)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors",
                      active ? "bg-[#bae6fd] text-bright" : "text-muted hover:bg-[#fff8e7] hover:text-bright",
                    )}
                  >
                    <span className="truncate">
                      <span className="text-dim">{repo.owner}/</span>
                      <span className="font-medium">{repo.name}</span>
                    </span>
                    {repo.private && <Lock className="size-3 shrink-0 text-dim" />}
                    {active && <Check className="ml-auto size-3.5 shrink-0 text-accent" />}
                  </button>
                );
              })}
              {visible.length === 0 && (
                <p className="px-3 py-6 text-center text-sm text-dim">No repositories match “{filter}”.</p>
              )}
            </div>
          </div>
        )}
      </div>

      {selected && (
        <div className="space-y-2">
          {branches === null ? (
            <div className="flex items-center gap-2 text-xs text-dim"><Spinner /> Loading branches…</div>
          ) : (
            <label className="flex items-center gap-2">
              <span className="text-xs text-dim">Base branch</span>
              <Select
                className="h-9 flex-1"
                value={value.baseBranch}
                onChange={(e) => onChange({ ...value, baseBranch: e.target.value })}
              >
                {branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}{b.protected ? " (protected)" : ""}
                  </option>
                ))}
              </Select>
            </label>
          )}

          {authorization && !authorization.ok && (
            <Notice tone="warn">
              <p>{authorization.reason}</p>
              {authorization.installUrl && (
                <a
                  href={authorization.installUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-block text-xs font-medium underline"
                >
                  {authorization.action === "configure"
                    ? "Add this repository to the kapi app →"
                    : "Install the kapi app →"}
                </a>
              )}
            </Notice>
          )}

          {authorization?.ok && (
            <p className="flex items-center gap-1.5 text-xs text-ok">
              <Check className="size-3.5" /> kapi can push to this repository.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
