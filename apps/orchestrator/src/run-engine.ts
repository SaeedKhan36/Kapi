import { randomUUID } from "node:crypto";
import { AgentChannel, type MessageBus } from "@kapi/bus";
import { createCodingEngine, type CodingEngine } from "@kapi/agent-engine";
import { decideRecovery, planFromSandbox } from "@kapi/agent-runtime";
import { createLLM, type RoutedLLM } from "@kapi/llm";
import type { AgentMessage, PlannedTask, RecoveryDecision, TaskGraph } from "@kapi/protocol";
import { remapDependencies, workerId } from "@kapi/protocol";
import {
  cloneRepo, createRemoteBranch, createSandboxProvider, integrationBranch, isEmptyRepo,
  mergeIntoIntegration, seedEmptyRepo, taskBranch, type ProviderName, type SandboxProvider,
} from "@kapi/sandbox";
import { openPullRequest, parseRepoUrl } from "./github.ts";
import { renderContract } from "./contract.ts";
import { runReview } from "./review-runner.ts";
import { runWorkerTask, type WorkerOutcome } from "./worker-runner.ts";
import type { Store } from "./store.ts";

export type RunRequest = {
  goal: string;
  repoUrl: string;
  baseBranch?: string;
  maxConcurrency?: number;
  maxTasks?: number;
  providerName?: ProviderName;
  /** Skip code review entirely. Each review costs one LLM request. */
  skipReview?: boolean;
  /** Revision attempts allowed after a change request. */
  maxReviewRounds?: number;
  /** Master interventions allowed per run. Each costs one LLM request. */
  maxRecoveries?: number;
  /** Times a single task may be dispatched before it is abandoned. */
  maxAttemptsPerTask?: number;
  /** Stop after planning, without dispatching any worker. */
  planOnly?: boolean;
  /**
   * Called as soon as the run row exists, before any planning happens. Lets an
   * HTTP caller get its runId back immediately and follow progress over the
   * websocket instead of holding a request open for minutes.
   */
  onStart?: (runId: string) => void;
};

export type RunEvent =
  | { kind: "redistribute"; runId: string; taskId: string; strategy: string; detail: string }
  | { kind: "status"; runId: string; status: string; detail?: string }
  | { kind: "message"; message: AgentMessage }
  | { kind: "plan"; runId: string; graph: TaskGraph }
  | { kind: "task"; runId: string; taskId: string; status: string; detail?: string };

/**
 * Injection points, defaulted to the real implementations. They exist so the
 * scheduler can be exercised against fakes - verifying dependency ordering and
 * failure propagation must not require a live API key or real sandboxes.
 */
export type RunEngineDeps = {
  onEvent?: (e: RunEvent) => void;
  createLlm?: (onUsage: (u: { requests: number; totalTokens: number }) => void) => RoutedLLM;
  createEngine?: (llm: RoutedLLM) => CodingEngine;
  createProvider?: (name?: ProviderName) => SandboxProvider;
  /** Bypasses the LLM planner with a fixed graph. Used by scheduler tests. */
  planOverride?: (req: RunRequest) => Promise<TaskGraph>;
};

export class RunEngine {
  constructor(
    private store: Store,
    private bus: MessageBus,
    private opts: RunEngineDeps = {},
  ) {}

  #emit(e: RunEvent) { this.opts.onEvent?.(e); }

  /**
   * Serialises integration-branch merges. Workers finish concurrently, and two
   * simultaneous pushes to the same branch would reject each other.
   */
  #mergeLock: Promise<unknown> = Promise.resolve();
  #withMergeLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#mergeLock.then(fn, fn);
    this.#mergeLock = next.catch(() => undefined);
    return next;
  }

  #identity() {
    return {
      name: process.env.GIT_AUTHOR_NAME ?? "kapi-agent",
      email: process.env.GIT_AUTHOR_EMAIL ?? "agent@kapi.local",
    };
  }

  /**
   * Executes a full run: plan in an isolated master sandbox, then schedule
   * workers across the dependency graph until everything is terminal.
   */
  async execute(req: RunRequest): Promise<{ runId: string; outcomes: Map<string, WorkerOutcome> }> {
    const runId = randomUUID().slice(0, 8);
    const baseBranch = req.baseBranch ?? "main";
    const provider = (this.opts.createProvider ?? createSandboxProvider)(req.providerName);
    const maxConcurrency = req.maxConcurrency ?? Number(process.env.MAX_CONCURRENT_WORKERS ?? 4);
    const idleTtlSeconds = Number(process.env.SANDBOX_IDLE_TTL_SECONDS ?? 900);

    await this.store.createRun({
      id: runId, goal: req.goal, repoUrl: req.repoUrl, baseBranch,
      integrationBranch: integrationBranch(runId), sandboxProvider: provider.name,
    });
    req.onStart?.(runId);

    // Persist every message that crosses the bus, for audit and for the UI.
    const unsubscribe = this.bus.subscribeAll(runId, (m) => {
      void this.store.recordMessage(m);
      this.#emit({ kind: "message", message: m });
    });

    const onUsage = (u: { requests: number; totalTokens: number }) => {
      void this.store.updateRun(runId, { llmRequests: u.requests, llmTokens: u.totalTokens });
    };
    const llm = this.opts.createLlm
      ? this.opts.createLlm(onUsage)
      : createLLM({ onUsage });
    const master = new AgentChannel(this.bus, runId, "master");
    const outcomes = new Map<string, WorkerOutcome>();

    try {
      if (!this.opts.planOverride && !llm.isAvailable()) {
        throw new Error("no LLM provider configured - set GEMINI_API_KEY (free at aistudio.google.com/apikey)");
      }

      const graph = this.opts.planOverride
        ? await this.#usePlanOverride(runId, req, master, provider, baseBranch, idleTtlSeconds)
        : await this.#plan(runId, req, provider, llm, master, baseBranch, idleTtlSeconds);

      if (req.planOnly) {
        await this.store.updateRun(runId, { status: "planned", finishedAt: new Date() });
        this.#emit({ kind: "status", runId, status: "planned" });
        return { runId, outcomes };
      }

      await this.#schedule(runId, req, graph, provider, llm, master, outcomes, {
        baseBranch: integrationBranch(runId), maxConcurrency, idleTtlSeconds,
      });

      await this.#openPullRequests(runId, req, graph, outcomes, baseBranch);

      const failed = [...outcomes.values()].filter((o) => !o.ok).length;
      const status = failed === 0 ? "completed" : "completed_with_failures";
      await this.store.updateRun(runId, { status, finishedAt: new Date() });
      this.#emit({ kind: "status", runId, status });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await this.store.updateRun(runId, { status: "failed", error: detail, finishedAt: new Date() });
      this.#emit({ kind: "status", runId, status: "failed", detail });
      throw err;
    } finally {
      await master.close();
      unsubscribe();
      await provider.destroyAll?.();
    }

    return { runId, outcomes };
  }

  async #usePlanOverride(
    runId: string, req: RunRequest, master: AgentChannel,
    provider: SandboxProvider, baseBranch: string, idleTtlSeconds: number,
  ): Promise<TaskGraph> {
    // Still needs a sandbox: the repo has to be prepared even though the plan
    // is already known.
    const box = await provider.create({
      name: `${runId}-prepare`,
      env: { KAPI_RUN_ID: runId, KAPI_AGENT_ID: "master" },
      idleTtlSeconds,
    });
    try {
      await this.#prepareRepo(runId, req, provider, box.id, baseBranch);
    } finally {
      await provider.destroy(box.id).catch(() => {});
    }

    const graph = await this.opts.planOverride!(req);
    await this.store.savePlan(runId, graph);
    await master.send("broadcast", "PLAN_READY", `planned ${graph.tasks.length} task(s)`, {
      dependsOn: graph.tasks.map((t) => t.id),
    });
    this.#emit({ kind: "plan", runId, graph });
    return graph;
  }

  /**
   * Phase 3: raise a pull request for every branch that actually reached the
   * remote. Nothing is merged - a human reviews and merges, which is the whole
   * point of putting agents behind a PR rather than letting them push to main.
   */
  async #openPullRequests(
    runId: string, req: RunRequest, graph: TaskGraph,
    outcomes: Map<string, WorkerOutcome>, baseBranch: string,
  ) {
    const token = process.env.GITHUB_TOKEN;
    const ref = parseRepoUrl(req.repoUrl);
    if (!token || !ref) return;

    const merged = [...outcomes.entries()].filter(([, o]) => o.merged);
    const orphaned = [...outcomes.entries()].filter(([, o]) => o.pushed && !o.merged);

    // Nothing reached the integration branch, so there is nothing to propose.
    if (merged.length === 0) {
      if (orphaned.length > 0) {
        this.#emit({
          kind: "status", runId, status: "no-pr",
          detail: `${orphaned.length} branch(es) pushed but not merged: ${orphaned.map(([id]) => id).join(", ")}`,
        });
      }
      return;
    }

    const integration = integrationBranch(runId);
    const body = [
      `## ${graph.goal}`,
      "",
      `${merged.length} task(s) merged into \`${integration}\`.`,
      "",
      ...merged.map(([taskId, o]) => {
        const task = graph.tasks.find((t) => t.id === taskId);
        const files = o.filesChanged.slice(0, 12).map((f) => f.path).join(", ");
        const more = o.filesChanged.length > 12 ? `, +${o.filesChanged.length - 12} more` : "";
        const verdict = o.review
          ? `\n_Reviewed: **${o.review.decision === "approve" ? "approved" : "changes requested"}**` +
            `${o.reviewRounds > 1 ? ` after ${o.reviewRounds - 1} revision(s)` : ""} — ${o.review.summary}_`
          : "";
        const advisory = (o.review?.findings ?? []).filter((f) => f.severity === "minor" || f.severity === "nit");
        const notes = advisory.length
          ? `\n\nReviewer notes (non-blocking):\n${advisory.map((f) => `- ${f.file ? `\`${f.file}\`: ` : ""}${f.issue}`).join("\n")}`
          : "";
        return [
          `### ${task?.title ?? taskId}`,
          o.summary,
          o.filesChanged.length ? `\n\`${files}${more}\`` : "",
          verdict,
          notes,
        ].filter(Boolean).join("\n");
      }),
      orphaned.length
        ? `\n> Not included: ${orphaned.map(([id]) => id).join(", ")} — pushed but did not merge cleanly.`
        : "",
      "",
      `Generated by kapi run \`${runId}\`. Review before merging.`,
    ].filter(Boolean).join("\n");

    try {
      const pr = await openPullRequest(token, ref, {
        head: integration,
        base: baseBranch,
        title: graph.goal.length > 70 ? graph.goal.slice(0, 67) + "…" : graph.goal,
        body,
      });
      await this.store.updateRun(runId, { prUrl: pr.html_url });
      await this.store.saveArtifact(runId, "pull-request", { url: pr.html_url, number: pr.number });
      this.#emit({ kind: "status", runId, status: "pr-opened", detail: pr.html_url });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.#emit({ kind: "status", runId, status: "pr-failed", detail });
    }
  }

  /**
   * Phase 0: get the repository into a state the run can work with.
   *
   * Always runs, including when a stored plan is reused — an integration branch
   * is infrastructure, not a planning artefact, and skipping it leaves every
   * worker branching from the wrong place.
   */
  async #prepareRepo(
    runId: string, req: RunRequest, provider: SandboxProvider,
    sandboxId: string, baseBranch: string,
  ): Promise<void> {
    await cloneRepo(provider, sandboxId, {
      repoUrl: req.repoUrl,
      branch: baseBranch,
      token: process.env.GITHUB_TOKEN,
      identity: this.#identity(),
      dir: "repo",
      depth: 50,
    });

    // A brand-new GitHub repo has no commits, so there is no HEAD to diff
    // against and no base for a PR. Give it a root commit first.
    if (await isEmptyRepo(provider, sandboxId, "repo")) {
      if (!process.env.GITHUB_TOKEN) {
        throw new Error(`${req.repoUrl} is empty and GITHUB_TOKEN is not set, so it cannot be initialised`);
      }
      this.#emit({ kind: "status", runId, status: "preparing", detail: "repository is empty - creating base branch" });
      await seedEmptyRepo(provider, sandboxId, {
        branch: baseBranch,
        token: process.env.GITHUB_TOKEN,
        dir: "repo",
        readmeTitle: req.repoUrl.split("/").pop()?.replace(/\.git$/, "") ?? "Project",
      });
    }

    if (process.env.GITHUB_TOKEN) {
      // Every worker branches from here, and finished work merges back into it,
      // so a dependant actually inherits what it was waiting on.
      await createRemoteBranch(provider, sandboxId, {
        branch: integrationBranch(runId),
        from: baseBranch,
        token: process.env.GITHUB_TOKEN,
        dir: "repo",
      });
    }
  }

  /** Phase 1: the master reads the repo read-only and produces a validated DAG. */
  async #plan(
    runId: string, req: RunRequest, provider: SandboxProvider, llm: RoutedLLM,
    master: AgentChannel, baseBranch: string, idleTtlSeconds: number,
  ): Promise<TaskGraph> {
    this.#emit({ kind: "status", runId, status: "planning" });
    await this.store.upsertAgent({ runId, agentId: "master", role: "master", status: "planning" });

    const box = await provider.create({
      name: `${runId}-master`,
      env: { KAPI_RUN_ID: runId, KAPI_AGENT_ID: "master" },
      idleTtlSeconds,
      cpus: 1,
      memoryMb: 2048,
    });
    await this.store.upsertAgent({ runId, agentId: "master", role: "master", status: "planning", sandboxId: box.id });

    try {
      await this.#prepareRepo(runId, req, provider, box.id, baseBranch);

      const { graph, digest, attempts } = await planFromSandbox(
        llm, provider, box.id, req.goal, { cwd: "repo", maxTasks: req.maxTasks },
      );

      await this.store.savePlan(runId, graph);
      await this.store.saveArtifact(runId, "plan", graph);
      await this.store.saveArtifact(runId, "contract", graph.contract);

      await master.send("broadcast", "PLAN_READY",
        `planned ${graph.tasks.length} task(s) from ${digest.totalFiles} files (${attempts} attempt(s))`,
        { dependsOn: graph.tasks.map((t) => t.id) });

      this.#emit({ kind: "plan", runId, graph });
      return graph;
    } finally {
      await provider.destroy(box.id).catch(() => {});
      await this.store.stopAgent(runId, "master", "idle");
    }
  }

  /**
   * Phase 2: dispatch every task whose dependencies are satisfied, up to the
   * concurrency limit, until nothing is left to run.
   *
   * A task whose dependency failed is marked blocked rather than attempted -
   * running it would produce code against a contract half of which never landed.
   */
  async #schedule(
    runId: string, req: RunRequest, graph: TaskGraph, provider: SandboxProvider,
    llm: RoutedLLM, master: AgentChannel, outcomes: Map<string, WorkerOutcome>,
    cfg: { baseBranch: string; maxConcurrency: number; idleTtlSeconds: number },
  ) {
    const engine = (this.opts.createEngine ?? createCodingEngine)(llm);
    const contract = renderContract(graph.contract);

    /**
     * The task set is mutable: the master may retry a task, replace it with
     * different ones, or release dependants from it while the run is in flight.
     * A fixed array cannot express any of that.
     */
    const tasks = new Map<string, PlannedTask>(graph.tasks.map((t) => [t.id, t]));

    const succeeded = new Set<string>();
    const failed = new Set<string>();
    const started = new Set<string>();
    const attempts = new Map<string, number>();
    const inFlight = new Map<string, Promise<void>>();

    const maxRecoveries = req.maxRecoveries ?? Number(process.env.KAPI_MAX_RECOVERIES ?? 2);
    const maxAttempts = req.maxAttemptsPerTask ?? 2;
    let recoveriesUsed = 0;

    const dependantsOf = (id: string) =>
      [...tasks.values()].filter((t) => t.dependsOn.includes(id)).map((t) => t.id);

    /**
     * Decides what to do about a failed task and rewrites the graph.
     * Returns true when the task should be treated as failed for good.
     */
    const recover = async (task: PlannedTask, outcome: WorkerOutcome | null, error?: string): Promise<boolean> => {
      const attemptCount = attempts.get(task.id) ?? 1;

      if (recoveriesUsed >= maxRecoveries) {
        this.#emit({
          kind: "redistribute", runId, taskId: task.id, strategy: "abandon",
          detail: `recovery budget spent (${maxRecoveries})`,
        });
        return true;
      }
      if (attemptCount >= maxAttempts) {
        this.#emit({
          kind: "redistribute", runId, taskId: task.id, strategy: "abandon",
          detail: `already attempted ${attemptCount} time(s)`,
        });
        return true;
      }

      recoveriesUsed++;
      let decision: RecoveryDecision;
      try {
        const result = await decideRecovery(llm, {
          task,
          failure: {
            summary: outcome?.summary ?? error ?? "the worker did not report a reason",
            error,
            log: outcome?.log,
            attempts: attemptCount,
            incomplete: outcome?.incomplete ?? false,
            review: outcome?.review ?? null,
          },
          existingIds: [...tasks.keys()].filter((id) => id !== task.id),
          dependants: dependantsOf(task.id),
          goal: graph.goal,
          contract,
        });
        decision = result.decision;
      } catch (err) {
        // A failed recovery must not take the run down with it.
        this.#emit({
          kind: "redistribute", runId, taskId: task.id, strategy: "abandon",
          detail: `master could not decide: ${err instanceof Error ? err.message : String(err)}`,
        });
        return true;
      }

      await master.send("broadcast", "PLAN_REVISED",
        `${task.id}: ${decision.strategy} — ${decision.reasoning}`, { taskId: task.id });
      this.#emit({
        kind: "redistribute", runId, taskId: task.id,
        strategy: decision.strategy, detail: decision.reasoning,
      });

      if (decision.strategy === "retry") {
        // Re-dispatch with the master's guidance appended, so the worker does
        // something different rather than repeating what already failed.
        tasks.set(task.id, {
          ...task,
          instruction: `${task.instruction}\n\n---\n\nA previous attempt failed. The master's guidance:\n${decision.guidance}`,
        });
        started.delete(task.id);
        await this.store.setTaskStatus(runId, task.id, "pending", { error: null });
        return false;
      }

      if (decision.strategy === "rescope") {
        const replacementIds = decision.replacementTasks.map((t) => t.id);
        tasks.delete(task.id);
        // Anything waiting on the replaced task must now wait on its
        // replacements, or it blocks forever on an id that will never run.
        for (const [id, t] of tasks) {
          const [remapped] = remapDependencies([t], task.id, replacementIds);
          tasks.set(id, remapped);
        }
        for (const replacement of decision.replacementTasks) {
          tasks.set(replacement.id, replacement);
          await this.store.setTaskStatus(runId, replacement.id, "pending").catch(() => {});
        }
        await this.store.savePlanAdditions(runId, decision.replacementTasks);
        await this.store.setTaskStatus(runId, task.id, "cancelled", {
          error: `rescoped into: ${replacementIds.join(", ")}`,
        });
        await this.store.saveArtifact(runId, "recovery", decision, task.id);
        return false;
      }

      // abandon
      await this.store.saveArtifact(runId, "recovery", decision, task.id);
      if (decision.dependantsCanProceed) {
        // Release dependants: their work stands on its own without this task.
        for (const [id, t] of tasks) {
          if (t.dependsOn.includes(task.id)) {
            tasks.set(id, { ...t, dependsOn: t.dependsOn.filter((d) => d !== task.id) });
          }
        }
      }
      return true;
    };

    const launch = (task: PlannedTask) => {
      started.add(task.id);
      attempts.set(task.id, (attempts.get(task.id) ?? 0) + 1);
      const worker = workerId(task.role);

      const promise = (async () => {
        await this.store.setTaskStatus(runId, task.id, "running", {
          assignedTo: worker, startedAt: new Date(), branch: taskBranch(runId, task.id),
          attempts: attempts.get(task.id) ?? 1,
        });
        await this.store.upsertAgent({ runId, agentId: worker, role: task.role, status: "running" });
        if (!req.skipReview) {
          await this.store.upsertAgent({ runId, agentId: "worker:reviewer", role: "reviewer", status: "idle" });
        }
        this.#emit({ kind: "task", runId, taskId: task.id, status: "running" });

        const channel = new AgentChannel(this.bus, runId, worker);
        const off = channel.onMessage((m) => {
          if (m.type === "QUERY" || m.type === "NEEDS_HELP") {
            void channel.reply(m, "QUERY_RESPONSE",
              `I am mid-task on "${task.title}". Build against the shared contract:\n${contract}`);
          }
        });

        try {
          await master.send(worker, "TASK_ASSIGNED", task.instruction, {
            taskId: task.id, status: "assigned", dependsOn: task.dependsOn,
          });

          const outcome = await runWorkerTask(
            {
              runId, repoUrl: req.repoUrl, baseBranch: cfg.baseBranch,
              githubToken: process.env.GITHUB_TOKEN, provider, engine, contract,
              identity: this.#identity(),
              idleTtlSeconds: cfg.idleTtlSeconds,
              maxReviewRounds: req.maxReviewRounds ?? 1,
              review: req.skipReview
                ? undefined
                : async ({ branch, task: reviewed, summary }) => {
                    const verdict = await runReview(llm, provider, {
                      runId,
                      repoUrl: req.repoUrl,
                      integration: integrationBranch(runId),
                      branch,
                      task: reviewed,
                      contract,
                      workerSummary: summary,
                      githubToken: process.env.GITHUB_TOKEN,
                      idleTtlSeconds: cfg.idleTtlSeconds,
                    });
                    await this.store.saveArtifact(runId, "review", verdict, reviewed.id);
                    this.#emit({
                      kind: "task", runId, taskId: reviewed.id, status: "review",
                      detail: `review: ${verdict.decision} — ${verdict.summary}`,
                    });
                    return verdict;
                  },
              mergeBack: process.env.GITHUB_TOKEN
                ? ({ sandboxId, branch }) =>
                    this.#withMergeLock(() =>
                      mergeIntoIntegration(provider, sandboxId, {
                        integration: integrationBranch(runId),
                        branch,
                        token: process.env.GITHUB_TOKEN,
                        dir: "repo",
                      }),
                    )
                : undefined,
            },
            task, channel,
          );

          outcomes.set(task.id, outcome);

          if (outcome.ok) {
            succeeded.add(task.id);
            await this.store.setTaskStatus(runId, task.id, "review", {
              finishedAt: new Date(), branch: outcome.branch, error: null,
            });
            await this.store.saveArtifact(runId, "worker-result", outcome, task.id);
            this.#emit({
              kind: "task", runId, taskId: task.id, status: "review",
              detail: `${outcome.filesChanged.length} file(s), ${outcome.commits.length} commit(s)` +
                (outcome.incomplete ? " — cut off at step limit" : ""),
            });
            return;
          }

          // Failed: ask the master what to do before giving up on it.
          const giveUp = await recover(task, outcome);
          if (giveUp) {
            failed.add(task.id);
            await this.store.setTaskStatus(runId, task.id, "failed", {
              finishedAt: new Date(), branch: outcome.branch, error: outcome.summary,
            });
            this.#emit({ kind: "task", runId, taskId: task.id, status: "failed", detail: outcome.summary });
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          const giveUp = await recover(task, null, detail);
          if (giveUp) {
            failed.add(task.id);
            await this.store.setTaskStatus(runId, task.id, "failed", { error: detail, finishedAt: new Date() });
            this.#emit({ kind: "task", runId, taskId: task.id, status: "failed", detail });
          }
        } finally {
          off();
          await channel.close();
          await this.store.stopAgent(runId, worker);
          inFlight.delete(task.id);
        }
      })();

      inFlight.set(task.id, promise);
    };

    // Drain loop: launch whatever is ready, wait for the first completion, repeat.
    // The task set can change between iterations, so it is re-read every pass.
    for (;;) {
      for (const task of [...tasks.values()]) {
        if (started.has(task.id) || inFlight.size >= cfg.maxConcurrency) continue;

        const deadDeps = task.dependsOn.filter((d) => failed.has(d));
        if (deadDeps.length > 0) {
          started.add(task.id);
          failed.add(task.id);
          await this.store.setTaskStatus(runId, task.id, "blocked", {
            error: `dependency failed: ${deadDeps.join(", ")}`,
          });
          await master.send("broadcast", "BLOCKED",
            `${task.id} cannot run - dependency failed: ${deadDeps.join(", ")}`,
            { taskId: task.id, status: "blocked" });
          this.#emit({ kind: "task", runId, taskId: task.id, status: "blocked", detail: deadDeps.join(", ") });
          continue;
        }

        if (task.dependsOn.every((d) => succeeded.has(d))) launch(task);
      }

      if (inFlight.size === 0) {
        const remaining = [...tasks.values()].filter((t) => !started.has(t.id));
        if (remaining.length === 0) break;

        // Nothing running and nothing launchable: the rest can never satisfy
        // their dependencies. Never spin.
        for (const t of remaining) {
          started.add(t.id);
          failed.add(t.id);
          await this.store.setTaskStatus(runId, t.id, "blocked", { error: "unsatisfiable dependencies" });
          this.#emit({ kind: "task", runId, taskId: t.id, status: "blocked", detail: "unsatisfiable dependencies" });
        }
        break;
      }

      await Promise.race(inFlight.values());
    }

    // The plan the run actually executed, which may differ from the one planned.
    graph.tasks = [...tasks.values()];
  }
}
