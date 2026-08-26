import type { CodingEngine, CodingResult } from "@kapi/agent-engine";
import { createBranch, pushBranch } from "@kapi/agent-engine";
import type { AgentChannel } from "@kapi/bus";
import type { PlannedTask, ReviewVerdict } from "@kapi/protocol";
import { blockingFindings, detach, renderChangeRequest, workerId } from "@kapi/protocol";
import { cloneRepo, taskBranch, type MergeResult, type SandboxProvider } from "@kapi/sandbox";

export type WorkerConfig = {
  runId: string;
  repoUrl: string;
  baseBranch: string;
  githubToken?: string;
  provider: SandboxProvider;
  engine: CodingEngine;
  contract: string;
  identity: { name: string; email: string };
  idleTtlSeconds: number;
  /**
   * Merges the finished branch into the run's integration branch while this
   * sandbox is still alive. Serialised by the caller - concurrent pushes to one
   * branch race. Omitted when there is nowhere to push.
   */
  mergeBack?: (args: { sandboxId: string; branch: string }) => Promise<MergeResult>;
  /** Judges the pushed branch. Omitted to skip review entirely. */
  review?: (args: { branch: string; task: PlannedTask; summary: string }) => Promise<ReviewVerdict>;
  /** How many times a worker may revise after a change request. */
  maxReviewRounds?: number;
};

export type WorkerOutcome = CodingResult & {
  branch: string;
  pushed: boolean;
  merged: boolean;
  mergeConflict: boolean;
  review: ReviewVerdict | null;
  reviewRounds: number;
  sandboxSeconds: number;
};

/**
 * Runs exactly one task to completion in its own sandbox on its own branch.
 *
 * The sandbox is always destroyed, even on failure - a leaked Daytona sandbox
 * bills per second against a finite trial credit.
 */
export async function runWorkerTask(
  cfg: WorkerConfig,
  task: PlannedTask,
  channel: AgentChannel,
  onLog?: (line: string) => void,
): Promise<WorkerOutcome> {
  const me = workerId(task.role);
  const branch = taskBranch(cfg.runId, task.id);
  const startedAt = Date.now();
  let sandboxId = "";

  const log = (line: string) => {
    onLog?.(line);
    detach(channel.send("master", "LOG", line, { taskId: task.id }), "forwarding a worker log line");
  };

  try {
    const box = await cfg.provider.create({
      name: `${cfg.runId}-${task.id}`,
      // No GitHub credential here, deliberately. The agent inside this sandbox
      // executes model-chosen shell commands against repository contents, so
      // anything in its environment is one `echo` away from a prompt injection.
      // Git operations get a scoped token through withGitAuth instead, for the
      // duration of the command and no longer.
      env: {
        KAPI_RUN_ID: cfg.runId,
        KAPI_TASK_ID: task.id,
        KAPI_AGENT_ID: me,
      },
      idleTtlSeconds: cfg.idleTtlSeconds,
      cpus: 1,
      memoryMb: 2048,
    });
    sandboxId = box.id;

    await channel.send("master", "TASK_STARTED", `starting ${task.title}`, {
      taskId: task.id, status: "running",
    });

    await cloneRepo(cfg.provider, sandboxId, {
      repoUrl: cfg.repoUrl,
      branch: cfg.baseBranch,
      token: cfg.githubToken,
      identity: cfg.identity,
      dir: "repo",
      depth: 50,
    });
    await createBranch(cfg.provider, sandboxId, "repo", branch);

    const ctx = { provider: cfg.provider, sandboxId, cwd: "repo", onLog: log };
    await cfg.engine.ensureInstalled(ctx);

    let result = await cfg.engine.runTask(ctx, {
      taskId: task.id,
      title: task.title,
      instruction: task.instruction,
      contract: cfg.contract,
      acceptance: task.acceptance,
      touches: task.touches,
    });

    const push = async () => {
      if (!cfg.githubToken) return false;
      try {
        await pushBranch(cfg.provider, sandboxId, "repo", branch, cfg.githubToken);
        return true;
      } catch (err) {
        log(`[worker] push failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    };

    let pushed = false;
    let merged = false;
    let mergeConflict = false;
    let review: ReviewVerdict | null = null;
    let reviewRounds = 0;

    if (result.commits.length > 0) pushed = await push();

    // --- review, with a bounded chance to address blocking findings ---
    if (pushed && cfg.review) {
      const maxRounds = cfg.maxReviewRounds ?? 1;

      for (let round = 0; round <= maxRounds; round++) {
        await channel.send("master", "CODE_REVIEW_REQUESTED", `review ${branch}`, {
          taskId: task.id, files: result.filesChanged,
        });

        review = await cfg.review({ branch, task, summary: result.summary });
        reviewRounds = round + 1;

        const blocking = blockingFindings(review);
        if (review.decision === "approve") {
          log(`[review] approved: ${review.summary}`);
          await channel.send("master", "REVIEW_APPROVED", review.summary, {
            taskId: task.id, status: "review",
          });
          break;
        }

        log(`[review] changes requested (${blocking.length} blocking): ${review.summary}`);
        await channel.send("master", "CHANGE_REQUESTED", review.summary, {
          taskId: task.id,
          files: blocking.filter((f) => f.file).map((f) => ({ path: f.file!, action: "modified" as const })),
        });

        // Out of rounds: leave the branch pushed and unmerged for a human.
        if (round === maxRounds) {
          log(`[review] no revision rounds left; leaving ${branch} for human review`);
          break;
        }

        // Revise: same sandbox, same branch, instruction replaced by the findings.
        result = await cfg.engine.runTask(ctx, {
          taskId: task.id,
          title: `${task.title} (revision ${round + 1})`,
          instruction: `${task.instruction}\n\n---\n\n${renderChangeRequest(review)}`,
          contract: cfg.contract,
          acceptance: task.acceptance,
          touches: [...new Set([...task.touches, ...blocking.map((f) => f.file).filter(Boolean) as string[]])],
        });
        pushed = await push();
        if (!pushed) break;
      }
    }

    const approved = review === null || review.decision === "approve";
    const ok = result.ok && approved;

    // Merge only approved work, and only while the sandbox is still alive, so
    // dependants inherit it.
    if (pushed && ok && cfg.mergeBack) {
      const merge = await cfg.mergeBack({ sandboxId, branch });
      merged = merge.ok;
      mergeConflict = merge.conflicted;
      if (!merge.ok) {
        log(`[worker] merge into integration ${merge.conflicted ? "conflicted" : "failed"}: ${merge.detail}`);
        await channel.send("master", merge.conflicted ? "BLOCKED" : "TASK_FAILED",
          `could not merge ${branch} into the integration branch: ${merge.detail}`,
          { taskId: task.id });
      }
    }

    await channel.send("master", ok ? "TASK_COMPLETED" : "TASK_FAILED", result.summary, {
      taskId: task.id,
      status: ok ? "review" : "failed",
      files: result.filesChanged,
    });

    // Tell the team what landed, so dependants can react without asking.
    if (ok) {
      const signal = task.role === "backend" ? "API_READY"
        : task.role === "database" ? "SCHEMA_READY"
        : null;
      if (signal) {
        await channel.send("broadcast", signal, `${task.title} is available on ${branch}`, {
          taskId: task.id, files: result.filesChanged,
        });
      }
    }

    return {
      ...result,
      ok,
      branch, pushed, merged, mergeConflict, review, reviewRounds,
      sandboxSeconds: Math.round((Date.now() - startedAt) / 1000),
    };
  } finally {
    if (sandboxId) await cfg.provider.destroy(sandboxId).catch(() => {});
  }
}
