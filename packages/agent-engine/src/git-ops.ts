import type { SandboxProvider, ExecResult } from "@kapi/sandbox";
import { shellQuote } from "@kapi/sandbox";
import type { FileRef } from "@kapi/protocol";

export async function currentCommit(p: SandboxProvider, id: string, cwd: string): Promise<string> {
  return (await p.exec(id, "git rev-parse HEAD", { cwd })).stdout.trim();
}

export async function createBranch(p: SandboxProvider, id: string, cwd: string, branch: string) {
  const res = await p.exec(id, `git checkout -b ${shellQuote(branch)}`, { cwd });
  if (res.exitCode !== 0 && !res.stderr.includes("already exists")) {
    throw new Error(`failed to create branch ${branch}: ${res.stderr}`);
  }
}

/** Files changed since `sinceCommit`, including anything still uncommitted. */
export async function changedFiles(
  p: SandboxProvider, id: string, cwd: string, sinceCommit: string,
): Promise<FileRef[]> {
  const committed = await p.exec(id, `git diff --name-status ${shellQuote(sinceCommit)} HEAD`, { cwd });
  const working = await p.exec(id, "git status --porcelain", { cwd });

  const out = new Map<string, FileRef>();

  for (const line of committed.stdout.split("\n").filter(Boolean)) {
    const [status, ...rest] = line.trim().split(/\s+/);
    const path = rest.join(" ");
    if (!path) continue;
    out.set(path, { path, action: status.startsWith("A") ? "created" : status.startsWith("D") ? "deleted" : "modified" });
  }
  for (const line of working.stdout.split("\n").filter(Boolean)) {
    const status = line.slice(0, 2).trim();
    const path = line.slice(3).trim();
    if (!path) continue;
    out.set(path, { path, action: status.includes("?") || status.includes("A") ? "created" : status.includes("D") ? "deleted" : "modified" });
  }
  return [...out.values()];
}

export async function commitsSince(
  p: SandboxProvider, id: string, cwd: string, sinceCommit: string,
): Promise<string[]> {
  const res = await p.exec(id, `git log --oneline ${shellQuote(sinceCommit)}..HEAD`, { cwd });
  return res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Commits anything the engine left uncommitted, so no work is silently lost. */
export async function commitAll(
  p: SandboxProvider, id: string, cwd: string, message: string,
): Promise<ExecResult | null> {
  const status = await p.exec(id, "git status --porcelain", { cwd });
  if (!status.stdout.trim()) return null;
  await p.exec(id, "git add -A", { cwd });
  return p.exec(id, `git commit -m ${shellQuote(message)}`, { cwd });
}

export async function pushBranch(
  p: SandboxProvider, id: string, cwd: string, branch: string, token?: string,
) {
  const res = await p.exec(id, `git push -u origin ${shellQuote(branch)} 2>&1`, { cwd, timeoutMs: 120_000 });
  if (res.exitCode !== 0) {
    const msg = token ? (res.stdout + res.stderr).split(token).join("***") : res.stdout + res.stderr;
    throw new Error(`git push failed: ${msg}`);
  }
}
