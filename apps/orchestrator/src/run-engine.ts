import { randomUUID } from "node:crypto";
import { AgentChannel, type MessageBus } from "@kapi/bus";
import { createCodingEngine, type CodingEngine } from "@kapi/agent-engine";
import { planFromSandbox } from "@kapi/agent-runtime";
import { createLLM, type RoutedLLM } from "@kapi/llm";
import type { AgentMessage, PlannedTask, TaskGraph } from "@kapi/protocol";
import { workerId } from "@kapi/protocol";
import {
  cloneRepo, createSandboxProvider, integrationBranch, type ProviderName, type SandboxProvider,
} from "@kapi/sandbox";
import { renderContract } from "./contract.ts";
import { runWorkerTask, type WorkerOutcome } from "./worker-runner.ts";
import type { Store } from "./store.ts";

export type RunRequest = {
  goal: string;
  repoUrl: string;
  baseBranch?: string;
  maxConcurrency?: number;
  maxTasks?: number;
  providerName?: ProviderName;
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
        ? await this.#usePlanOverride(runId, req, master)
        : await this.#plan(runId, req, provider, llm, master, baseBranch, idleTtlSeconds);

      if (req.planOnly) {
        await this.store.updateRun(runId, { status: "planned", finishedAt: new Date() });
        this.#emit({ kind: "status", runId, status: "planned" });
        return { runId, outcomes };
      }

      await this.#schedule(runId, req, graph, provider, llm, master, outcomes, {
        baseBranch, maxConcurrency, idleTtlSeconds,
      });

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

  async #usePlanOverride(runId: string, req: RunRequest, master: AgentChannel): Promise<TaskGraph> {
    const graph = await this.opts.planOverride!(req);
    await this.store.savePlan(runId, graph);
    await master.send("broadcast", "PLAN_READY", `planned ${graph.tasks.length} task(s)`, {
      dependsOn: graph.tasks.map((t) => t.id),
    });
    this.#emit({ kind: "plan", runId, graph });
    return graph;
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
      await cloneRepo(provider, box.id, {
        repoUrl: req.repoUrl,
        branch: baseBranch,
        token: process.env.GITHUB_TOKEN,
        dir: "repo",
        depth: 50,
      });

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
    const byId = new Map(graph.tasks.map((t) => [t.id, t]));

    const succeeded = new Set<string>();
    const failed = new Set<string>();
    const started = new Set<string>();
    const inFlight = new Map<string, Promise<void>>();

    const blockedBy = (t: PlannedTask) => t.dependsOn.filter((d) => failed.has(d));
    const isReady = (t: PlannedTask) => t.dependsOn.every((d) => succeeded.has(d));

    const launch = (task: PlannedTask) => {
      started.add(task.id);
      const worker = workerId(task.role);

      const promise = (async () => {
        await this.store.setTaskStatus(runId, task.id, "running", {
          assignedTo: worker, startedAt: new Date(), branch: `kapi/run-${runId}/${task.id}`,
        });
        await this.store.upsertAgent({ runId, agentId: worker, role: task.role, status: "running" });
        this.#emit({ kind: "task", runId, taskId: task.id, status: "running" });

        const channel = new AgentChannel(this.bus, runId, worker);
        // Answer teammates from the shared contract rather than leaving them to time out.
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
              identity: {
                name: process.env.GIT_AUTHOR_NAME ?? "kapi-agent",
                email: process.env.GIT_AUTHOR_EMAIL ?? "agent@kapi.local",
              },
              idleTtlSeconds: cfg.idleTtlSeconds,
            },
            task, channel,
          );

          outcomes.set(task.id, outcome);
          (outcome.ok ? succeeded : failed).add(task.id);

          await this.store.setTaskStatus(runId, task.id, outcome.ok ? "review" : "failed", {
            finishedAt: new Date(), branch: outcome.branch,
            error: outcome.ok
              ? null
              : outcome.incomplete
                ? `hit the step limit with ${outcome.commits.length} commit(s) on ${outcome.branch} - branch is reviewable but unfinished`
                : outcome.summary,
          });
          await this.store.saveArtifact(runId, "worker-result", outcome, task.id);
          this.#emit({
            kind: "task", runId, taskId: task.id,
            status: outcome.ok ? "review" : "failed",
            detail: `${outcome.filesChanged.length} file(s), ${outcome.commits.length} commit(s)` +
              (outcome.incomplete ? " — cut off at step limit" : ""),
          });
        } catch (err) {
          failed.add(task.id);
          const detail = err instanceof Error ? err.message : String(err);
          await this.store.setTaskStatus(runId, task.id, "failed", { error: detail, finishedAt: new Date() });
          this.#emit({ kind: "task", runId, taskId: task.id, status: "failed", detail });
        } finally {
          off();
          await channel.close();
          await this.store.stopAgent(runId, worker);
          inFlight.delete(task.id);
        }
      })();

      inFlight.set(task.id, promise);
    };

    // Drain loop: launch what is ready, wait for the first completion, repeat.
    while (started.size < graph.tasks.length || inFlight.size > 0) {
      for (const task of graph.tasks) {
        if (started.has(task.id) || inFlight.size >= cfg.maxConcurrency) continue;

        const deadDeps = blockedBy(task);
        if (deadDeps.length > 0) {
          started.add(task.id);
          failed.add(task.id);
          await this.store.setTaskStatus(runId, task.id, "blocked", {
            error: `dependency failed: ${deadDeps.join(", ")}`,
          });
          await master.send("broadcast", "BLOCKED",
            `${task.id} cannot run - dependency failed: ${deadDeps.join(", ")}`, { taskId: task.id, status: "blocked" });
          this.#emit({ kind: "task", runId, taskId: task.id, status: "blocked", detail: deadDeps.join(", ") });
          continue;
        }

        if (isReady(task)) launch(task);
      }

      if (inFlight.size === 0) {
        const stuck = graph.tasks.filter((t) => !started.has(t.id));
        if (stuck.length > 0) {
          // Unreachable if validateTaskGraph did its job, but never spin forever.
          for (const t of stuck) {
            started.add(t.id);
            failed.add(t.id);
            await this.store.setTaskStatus(runId, t.id, "blocked", { error: "unsatisfiable dependencies" });
          }
        }
        break;
      }

      await Promise.race(inFlight.values());
    }
  }
}
