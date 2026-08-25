import type { SandboxProvider } from "./types.ts";
import { SandboxError } from "./types.ts";

export type GitIdentity = { name: string; email: string };

/** Injects a token into an https remote without ever logging it. */
export function authenticatedRemote(repoUrl: string, token?: string): string {
  if (!token) return repoUrl;
  try {
    const u = new URL(repoUrl);
    if (u.protocol !== "https:") return repoUrl;
    u.username = "x-access-token";
    u.password = token;
    return u.toString();
  } catch {
    return repoUrl;
  }
}

export const redact = (text: string, ...secrets: Array<string | undefined>): string =>
  secrets
    .filter((s): s is string => typeof s === "string" && s.length > 6)
    .reduce((acc, s) => acc.split(s).join("***"), text);

/**
 * Shallow-clones a repo into a sandbox and configures identity.
 * `depth` keeps clones fast; the master only ever needs a read-only view.
 */
export async function cloneRepo(
  provider: SandboxProvider,
  sandboxId: string,
  opts: {
    repoUrl: string;
    branch?: string;
    token?: string;
    identity?: GitIdentity;
    depth?: number;
    dir?: string;
  },
) {
  const dir = opts.dir ?? ".";
  const remote = authenticatedRemote(opts.repoUrl, opts.token);
  const branchArg = opts.branch ? `--branch ${shellQuote(opts.branch)}` : "";
  const depthArg = opts.depth === 0 ? "" : `--depth ${opts.depth ?? 50}`;

  const res = await provider.exec(
    sandboxId,
    `git clone ${depthArg} ${branchArg} ${shellQuote(remote)} ${shellQuote(dir)} 2>&1`,
    { timeoutMs: 180_000 },
  );
  if (res.exitCode !== 0) {
    throw new SandboxError(
      `git clone failed: ${redact(res.stdout + res.stderr, opts.token)}`,
      provider.name,
    );
  }

  const id = opts.identity ?? { name: "kapi-agent", email: "agent@kapi.local" };
  await provider.exec(
    sandboxId,
    [
      `git config user.name ${shellQuote(id.name)}`,
      `git config user.email ${shellQuote(id.email)}`,
      // Agents must never open an interactive editor or credential prompt.
      `git config core.editor true`,
      `git config advice.detachedHead false`,
    ].join(" && "),
    { cwd: dir === "." ? undefined : dir },
  );
}

export function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/** Branch name for one task's work. Slugs are already validated by the protocol. */
export const taskBranch = (runId: string, taskId: string) => `kapi/run-${runId}/${taskId}`;
export const integrationBranch = (runId: string) => `kapi/run-${runId}`;
