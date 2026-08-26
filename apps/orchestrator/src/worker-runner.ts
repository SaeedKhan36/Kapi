import type { CodingEngine, CodingResult } from "@kapi/agent-engine";
import { createBranch, pushBranch } from "@kapi/agent-engine";
import type { AgentChannel } from "@kapi/bus";
import type { PlannedTask } from "@kapi/protocol";
import { workerId } from "@kapi/protocol";
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
};

export type WorkerOutcome = CodingResult & {
  branch: string;
  pushed: boolean;
  merged: boolean;
  mergeConflict: boolean;
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
    void channel.send("master", "LOG", line, { taskId: task.id });
  };

  try {
    const box = await cfg.provider.create({
      name: `${cfg.runId}-${task.id}`,
      env: {
        KAPI_RUN_ID: cfg.runId,
        KAPI_TASK_ID: task.id,
        KAPI_AGENT_ID: me,
        ...(cfg.githubToken ? { GITHUB_TOKEN: cfg.githubToken } : {}),
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

    const result = await cfg.engine.runTask(ctx, {
      taskId: task.id,
      title: task.title,
      instruction: task.instruction,
      contract: cfg.contract,
      acceptance: task.acceptance,
      touches: task.touches,
    });

    let pushed = false;
    let merged = false;
    let mergeConflict = false;

    if (result.commits.length > 0 && cfg.githubToken) {
      try {
        await pushBranch(cfg.provider, sandboxId, "repo", branch, cfg.githubToken);
        pushed = true;
      } catch (err) {
        log(`[worker] push failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Merge before the sandbox is destroyed, so dependants inherit this work.
      if (pushed && result.ok && cfg.mergeBack) {
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
    }

    await channel.send("master", result.ok ? "TASK_COMPLETED" : "TASK_FAILED", result.summary, {
      taskId: task.id,
      status: result.ok ? "review" : "failed",
      files: result.filesChanged,
    });

    // Tell the team what landed, so dependants can react without asking.
    if (result.ok) {
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
      ...result, branch, pushed, merged, mergeConflict,
      sandboxSeconds: Math.round((Date.now() - startedAt) / 1000),
    };
  } finally {
    if (sandboxId) await cfg.provider.destroy(sandboxId).catch(() => {});
  }
}
