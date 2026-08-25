import type { SandboxProvider } from "@kapi/sandbox";

export type RepoDigest = {
  tree: string;
  files: Array<{ path: string; content: string; truncated: boolean }>;
  totalFiles: number;
  approxTokens: number;
};

/** Files that describe a project's shape, in priority order. */
const PRIORITY_PATTERNS = [
  "README.md", "readme.md", "CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md",
  "package.json", "pnpm-workspace.yaml", "tsconfig.json",
  "pyproject.toml", "requirements.txt", "setup.py",
  "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "Gemfile", "composer.json",
  "Dockerfile", "docker-compose.yml", "Makefile",
];

const IGNORED_DIRS = [
  "node_modules", ".git", "dist", "build", ".next", "target", "vendor",
  "__pycache__", ".venv", "venv", "coverage", ".turbo", ".cache", "out",
];

/** Rough but stable: ~4 chars per token is close enough for budgeting. */
export const approxTokens = (text: string) => Math.ceil(text.length / 4);

/**
 * Builds a compact description of a repository for the planner.
 *
 * Gemini's 1M context is generous but not free - every token is quota. So we
 * send a full directory tree (cheap, high signal about structure) plus the
 * contents of only the files that reveal conventions, under a hard budget.
 */
export async function buildRepoDigest(
  provider: SandboxProvider,
  sandboxId: string,
  opts: { cwd?: string; maxTokens?: number; maxFileTokens?: number } = {},
): Promise<RepoDigest> {
  const cwd = opts.cwd ?? "repo";
  const maxTokens = opts.maxTokens ?? 60_000;
  const maxFileTokens = opts.maxFileTokens ?? 6_000;

  const prune = IGNORED_DIRS.map((d) => `-path '*/${d}' -prune`).join(" -o ");
  const listing = await provider.exec(
    sandboxId,
    `find . \\( ${prune} \\) -o -type f -print 2>/dev/null | sed 's|^\\./||' | sort`,
    { cwd, timeoutMs: 60_000 },
  );

  const allFiles = listing.stdout.split("\n").map((l) => l.trim()).filter(Boolean);

  // Directory tree, capped so a huge monorepo cannot blow the budget on its own.
  const tree = allFiles.slice(0, 800).join("\n");
  let budget = maxTokens - approxTokens(tree);

  const ranked = [
    ...PRIORITY_PATTERNS.flatMap((p) => allFiles.filter((f) => f === p || f.endsWith(`/${p}`))),
    ...allFiles.filter((f) => /^(src|app|lib|api|server)\/[^/]+\.(ts|tsx|js|jsx|py|go|rs|java|rb)$/.test(f)),
  ];
  const seen = new Set<string>();
  const picks = ranked.filter((f) => !seen.has(f) && seen.add(f)).slice(0, 25);

  const files: RepoDigest["files"] = [];
  for (const path of picks) {
    if (budget <= 0) break;
    let content: string;
    try {
      content = await provider.readFile(sandboxId, `${cwd}/${path}`);
    } catch {
      continue;
    }
    const perFile = Math.min(maxFileTokens, budget);
    const limit = perFile * 4;
    const truncated = content.length > limit;
    const body = truncated ? content.slice(0, limit) + "\n... [truncated]" : content;
    files.push({ path, content: body, truncated });
    budget -= approxTokens(body);
  }

  const used = approxTokens(tree) + files.reduce((n, f) => n + approxTokens(f.content), 0);
  return { tree, files, totalFiles: allFiles.length, approxTokens: used };
}

/** Renders the digest into the prompt block the planner sees. */
export function renderDigest(digest: RepoDigest): string {
  const fileBlocks = digest.files
    .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");
  return [
    `## Repository structure (${digest.totalFiles} files)`,
    "```",
    digest.tree,
    "```",
    "",
    "## Key file contents",
    fileBlocks || "(no readable key files found)",
  ].join("\n");
}
