import { randomUUID } from "node:crypto";
import { AgentChannel, type MessageBus } from "@kapi/bus";
import { createCodingEngine, type CodingEngine } from "@kapi/agent-engine";
import { planFromSandbox } from "@kapi/agent-runtime";
import { createLLM, type RoutedLLM } from "@kapi/llm";
import type { AgentMessage, PlannedTask, TaskGraph } from "@kapi/protocol";
import { workerId } from "@kapi/protocol";
import {
  cloneRepo, createRemoteBranch, createSandboxProvider, integrationBranch, isEmptyRepo,
  mergeIntoIntegration, seedEmptyRepo, taskBranch, type ProviderName, type SandboxProvider,
} from "@kapi/sandbox";
import {
  createRepoAccess, openPullRequest, parseRepoUrl,
  type AuthorizationAction, type RepoAccess,
} from "@kapi/identity";
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
  /**
   * How this run reaches GitHub. Defaults to the PAT in the environment, which
   * is what the CLI and a single-operator deployment use. An HTTP caller passes
   * a GitHub App-backed one instead, so each sandbox only ever receives a token
   * scoped to the single repository it is working on.
   */
  repoAccess?: RepoAccess;
  /** Bypasses the LLM planner with a fixed graph. Used by scheduler tests. */
  planOverride?: (req: RunRequest) => Promise<TaskGraph>;
};

/**
 * The run was refused, rather than attempted and failed.
 *
 * Distinct from a generic error so the HTTP layer can answer 403 with a link
 * the user can act on instead of 500 with a stack trace.
 */
export class RunNotAuthorizedError extends Error {
  constructor(
    message: string,
    readonly action?: AuthorizationAction,
    readonly installUrl?: string,
  ) {
    super(message);
    this.name = "RunNotAuthorizedError";
  }
}

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

  #access(): RepoAccess {
    this.#repoAccess ??= this.opts.repoAccess ?? createRepoAccess();
    return this.#repoAccess;
  }
  #repoAccess: RepoAccess | undefined;

  /**
   * The credential for one repository, minted fresh at each git operation.
   *
   * Not resolved once per run on purpose: a GitHub App installation token
   * lasts an hour and a run can outlive that, so caching one for the duration
   * would fail late, mid-push, with nothing committed anywhere useful.
   */
  #tokenFor(repoUrl: string): Promise<string | undefined> {
    return this.#access().tokenFor(repoUrl);
  }

  /**
   * Refuses a run the caller is not entitled to make, before it costs anything.
   *
   * The message carries the remedy where there is one - installing the app on
   * the repository is a normal next step, not a failure the user can do
   * nothing about.
   */
  async #authorize(repoUrl: string): Promise<void> {
    const decision = await this.#access().authorize(repoUrl);
    if (decision.ok) return;

    throw new RunNotAuthorizedError(
      decision.installUrl ? `${decision.reason} ${decision.installUrl}` : decision.reason,
      decision.action,
      decision.installUrl,
    );
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

      // Before anything is spent. A sandbox costs money per second and an LLM
      // call costs a twentieth of the daily free quota, so an unauthorized run
      // should fail here rather than after planning.
      await this.#authorize(req.repoUrl);

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
    // The human's credential, not the sandbox one: a pull request should be
    // attributed to the person who asked for the run, not to a bot installation.
    const token = await this.#access().apiToken();
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
      token: await this.#tokenFor(req.repoUrl),
      identity: await this.#access().identity(),
      dir: "repo",
      depth: 50,
    });

    // A brand-new GitHub repo has no commits, so there is no HEAD to diff
    // against and no base for a PR. Give it a root commit first.
    if (await isEmptyRepo(provider, sandboxId, "repo")) {
      const token = await this.#tokenFor(req.repoUrl);
      if (!token) {
        throw new Error(
          `${req.repoUrl} is empty and there is no push credential for it, so it cannot be initialised`,
        );
      }
      this.#emit({ kind: "status", runId, status: "preparing", detail: "repository is empty - creating base branch" });
      await seedEmptyRepo(provider, sandboxId, {
        branch: baseBranch,
        token,
        dir: "repo",
        readmeTitle: req.repoUrl.split("/").pop()?.replace(/\.git$/, "") ?? "Project",
      });
    }

    if (await this.#tokenFor(req.repoUrl)) {
      // Every worker branches from here, and finished work merges back into it,
      // so a dependant actually inherits what it was waiting on.
      await createRemoteBranch(provider, sandboxId, {
        branch: integrationBranch(runId),
        from: baseBranch,
        token: await this.#tokenFor(req.repoUrl),
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
    const byId = new Map(graph.tasks.map((t) => [t.id, t]));

    // Whether pushing is possible at all decides the shape of the run - there
    // is no integration branch to merge into without it. The tokens themselves
    // are still minted per operation, since one may expire mid-run.
    const identity = await this.#access().identity();
    const canPush = Boolean(await this.#tokenFor(req.repoUrl));

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
        if (!req.skipReview) {
          await this.store.upsertAgent({ runId, agentId: "worker:reviewer", role: "reviewer", status: "idle" });
        }
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
              // Minted per worker rather than once per run: an installation
              // token lasts an hour, and a wide graph can run longer than that.
              githubToken: await this.#tokenFor(req.repoUrl),
              provider, engine, contract, identity,
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
                      githubToken: await this.#tokenFor(req.repoUrl),
                      idleTtlSeconds: cfg.idleTtlSeconds,
                    });
                    await this.store.saveArtifact(runId, "review", verdict, reviewed.id);
                    this.#emit({
                      kind: "task", runId, taskId: reviewed.id, status: "review",
                      detail: `review: ${verdict.decision} — ${verdict.summary}`,
                    });
                    return verdict;
                  },
              mergeBack: canPush
                ? ({ sandboxId, branch }) =>
                    this.#withMergeLock(async () =>
                      mergeIntoIntegration(provider, sandboxId, {
                        integration: integrationBranch(runId),
                        branch,
                        token: await this.#tokenFor(req.repoUrl),
                        dir: "repo",
                      }),
                    )
                : undefined,
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
