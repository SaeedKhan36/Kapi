/**
 * Drives one full run from the terminal.
 *
 *   pnpm run:agent --repo=https://github.com/you/repo.git --goal="add a /health endpoint"
 *   pnpm run:agent --repo=... --goal=... --provider=local --concurrency=2 --dry-plan
 */
import { loadEnv } from "../packages/env/src/index.ts";
loadEnv();

import { createDb, describeDbTarget } from "../packages/db/src/index.ts";
import { createMessageBus } from "../packages/bus/src/index.ts";
import { Store } from "../apps/orchestrator/src/store.ts";
import { RunEngine } from "../apps/orchestrator/src/run-engine.ts";
import type { ProviderName } from "../packages/sandbox/src/index.ts";

const arg = (name: string, fallback?: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;
const flag = (name: string) => process.argv.includes(`--${name}`);

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

const main = async () => {
  const repoUrl = arg("repo");
  const goal = arg("goal");

  if (!repoUrl || !goal) {
    console.error(`
${C.bold("usage")}: pnpm run:agent --repo=<git-url> --goal="<what to build>"

  --provider=local|docker|daytona   sandbox backend (default: $SANDBOX_PROVIDER or local)
  --branch=main                     base branch
  --concurrency=4                   max parallel workers
  --max-tasks=6                     cap the plan size
  --dry-plan                        plan only, do not run workers
  --no-review                       skip code review (saves 1 request per task)
  --review-rounds=1                 revision attempts after a change request
  --max-recoveries=2                master interventions allowed (1 request each)
  --max-attempts=2                  dispatches allowed per task before abandoning
  --reuse-plan=<runId>              re-run a previous run's plan without re-planning
                                    (saves the planning request against a tight quota)
`);
    process.exit(1);
  }

  const provider = arg("provider") as ProviderName | undefined;
  const db = await createDb();
  const store = new Store(db);
  const bus = createMessageBus();

  console.log(`\n${C.bold("kapi run")}`);
  console.log(`  goal:     ${goal}`);
  console.log(`  repo:     ${repoUrl}`);
  console.log(`  provider: ${C.cyan(provider ?? process.env.SANDBOX_PROVIDER ?? "local")}`);
  console.log(`  database: ${C.cyan(describeDbTarget())}`);
  console.log(`  push/PR:  ${process.env.GITHUB_TOKEN ? C.green("enabled") : C.yellow("disabled (no GITHUB_TOKEN)")}\n`);

  // Re-planning costs a request every time. When iterating on execution, reuse
  // a plan we already paid for.
  const reuseFrom = arg("reuse-plan");
  let planOverride: (() => Promise<any>) | undefined;
  if (reuseFrom) {
    const prior = await store.getRun(reuseFrom);
    if (!prior?.plan) {
      console.error(C.red(`run ${reuseFrom} has no stored plan`));
      process.exit(1);
    }
    console.log(`  ${C.dim("reusing plan from run " + reuseFrom)}\n`);
    planOverride = async () => prior.plan;
  }

  const engine = new RunEngine(store, bus, {
    ...(planOverride ? { planOverride } : {}),
    onEvent: (e) => {
      switch (e.kind) {
        case "status":
          console.log(`${C.dim(new Date().toLocaleTimeString())} ${C.bold("run")} ${e.status}${e.detail ? " - " + e.detail : ""}`);
          break;
        case "plan": {
          console.log(`\n${C.bold("plan")} ${e.graph.tasks.length} task(s)`);
          console.log(C.dim(`  contract: ${e.graph.contract.summary}`));
          for (const t of e.graph.tasks) {
            const deps = t.dependsOn.length ? C.dim(` <- ${t.dependsOn.join(", ")}`) : "";
            console.log(`  ${C.cyan(t.role.padEnd(10))} ${t.id}${deps}`);
            console.log(C.dim(`             ${t.title}`));
          }
          console.log();
          break;
        }
        case "task": {
          const colour = e.status === "failed" || e.status === "blocked" ? C.red
            : e.status === "review" ? C.green : C.dim;
          console.log(`${C.dim(new Date().toLocaleTimeString())} ${colour(e.status.padEnd(8))} ${e.taskId}${e.detail ? C.dim(" - " + e.detail) : ""}`);
          break;
        }
        case "redistribute": {
          const colour = e.strategy === "abandon" ? C.red : e.strategy === "rescope" ? C.yellow : C.cyan;
          console.log(
            `${C.dim(new Date().toLocaleTimeString())} ${colour("master".padEnd(8))} ` +
            `${e.strategy} ${e.taskId}${C.dim(" — " + e.detail)}`,
          );
          break;
        }
        case "message":
          if (e.message.type === "LOG") console.log(C.dim(`           ${e.message.content}`));
          break;
      }
    },
  });

  const started = Date.now();
  try {
    const { runId, outcomes } = await engine.execute({
      goal, repoUrl,
      baseBranch: arg("branch", "main"),
      maxConcurrency: Number(arg("concurrency", "4")),
      maxTasks: arg("max-tasks") ? Number(arg("max-tasks")) : undefined,
      providerName: provider,
      planOnly: flag("dry-plan"),
      skipReview: flag("no-review"),
      maxReviewRounds: Number(arg("review-rounds", "1")),
      maxRecoveries: Number(arg("max-recoveries", "2")),
      maxAttemptsPerTask: Number(arg("max-attempts", "2")),
    });

    console.log(`\n${C.bold("results")} ${C.dim(`run ${runId} in ${Math.round((Date.now() - started) / 1000)}s`)}`);
    for (const [taskId, o] of outcomes) {
      const noop = o.ok && o.commits.length === 0;
      const label = noop ? C.cyan("noop") : o.ok ? C.green("ok  ") : C.red("fail");
      console.log(`  ${label} ${taskId}${noop ? C.dim("  (nothing to change)") : ""}`);
      if (!noop) {
        console.log(C.dim(`       branch: ${o.branch}${o.pushed ? " (pushed)" : " (local only)"}`));
        console.log(C.dim(`       files:  ${o.filesChanged.map((f) => f.path).join(", ") || "none"}`));
      }
      console.log(C.dim(`       ${o.summary.split("\n")[0]}`));
      if (o.review) {
        const approved = o.review.decision === "approve";
        const blocking = o.review.findings.filter((f) => f.severity === "blocker" || f.severity === "major");
        console.log(
          `       ${approved ? C.green("reviewed: approved") : C.yellow("reviewed: changes requested")}` +
          C.dim(`${o.reviewRounds > 1 ? ` (after ${o.reviewRounds - 1} revision)` : ""} — ${o.review.summary}`),
        );
        for (const f of blocking) {
          console.log(C.dim(`         [${f.severity}] ${f.file ? f.file + ": " : ""}${f.issue}`));
        }
      }
    }

    const run = await store.getRun(runId);
    if (run?.prUrl) console.log(`\n${C.bold("pull request")} ${C.cyan(run.prUrl)}`);
    console.log(`\n${C.dim(`llm: ${run?.llmRequests} requests, ${run?.llmTokens} tokens`)}`);
    const failed = [...outcomes.values()].filter((o) => !o.ok).length;
    console.log(failed === 0 ? C.green("\nrun complete\n") : C.yellow(`\nrun complete with ${failed} failure(s)\n`));
  } catch (err) {
    console.error(C.red(`\nrun failed: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exit(1);
  } finally {
    await bus.close();
  }
  process.exit(0);
};

main();
