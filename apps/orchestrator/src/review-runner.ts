import { collectDiff, reviewChange } from "@kapi/agent-runtime";
import type { LLMProvider } from "@kapi/llm";
import type { PlannedTask, ReviewVerdict } from "@kapi/protocol";
import { cloneRepo, type SandboxProvider } from "@kapi/sandbox";

export type ReviewRequest = {
  runId: string;
  repoUrl: string;
  integration: string;
  branch: string;
  task: PlannedTask;
  contract: string;
  workerSummary: string;
  githubToken?: string;
  idleTtlSeconds: number;
};

/**
 * Reviews one branch from its own sandbox.
 *
 * A separate sandbox with a read-only clone is deliberate: the reviewer sees
 * what actually landed on the branch, not whatever state the worker's
 * filesystem happens to be in. It never writes, so nothing it does can alter
 * the change it is judging.
 */
export async function runReview(
  llm: LLMProvider,
  provider: SandboxProvider,
  req: ReviewRequest,
  onLog?: (line: string) => void,
): Promise<ReviewVerdict> {
  let sandboxId = "";
  try {
    const box = await provider.create({
      name: `${req.runId}-review-${req.task.id}`.slice(0, 48),
      env: { KAPI_RUN_ID: req.runId, KAPI_AGENT_ID: "reviewer" },
      idleTtlSeconds: req.idleTtlSeconds,
    });
    sandboxId = box.id;

    await cloneRepo(provider, sandboxId, {
      repoUrl: req.repoUrl,
      branch: req.branch,
      token: req.githubToken,
      dir: "repo",
      depth: 0, // full history: the diff needs a merge base with integration
    });

    const { diff, files, truncated } = await collectDiff(provider, sandboxId, {
      base: req.integration,
      branch: req.branch,
      cwd: "repo",
    });
    onLog?.(`[review] ${files.length} file(s), ${diff.length} chars${truncated ? " (truncated)" : ""}`);

    return await reviewChange(llm, {
      task: req.task,
      contract: req.contract,
      diff,
      filesChanged: files,
      workerSummary: req.workerSummary,
    });
  } finally {
    if (sandboxId) await provider.destroy(sandboxId).catch(() => {});
  }
}
