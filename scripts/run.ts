/**
 * Drives one full run from the terminal.
 *
 *   pnpm run:agent --repo=https://github.com/you/repo.git --goal="add a /health endpoint"
 *   pnpm run:agent --repo=... --goal=... --provider=local --concurrency=2 --dry-plan
 */
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

  const engine = new RunEngine(store, bus, {
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
        case "message":
          if (e.message.type === "LOG") console.log(C.dim(`           ${e.message.content}`));
          break;
      }
    },
  });

  if (flag("dry-plan")) process.env.KAPI_DRY_PLAN = "1";

  const started = Date.now();
  try {
    const { runId, outcomes } = await engine.execute({
      goal, repoUrl,
      baseBranch: arg("branch", "main"),
      maxConcurrency: Number(arg("concurrency", "4")),
      maxTasks: arg("max-tasks") ? Number(arg("max-tasks")) : undefined,
      providerName: provider,
    });

    console.log(`\n${C.bold("results")} ${C.dim(`run ${runId} in ${Math.round((Date.now() - started) / 1000)}s`)}`);
    for (const [taskId, o] of outcomes) {
      console.log(`  ${o.ok ? C.green("ok  ") : C.red("fail")} ${taskId}`);
      console.log(C.dim(`       branch: ${o.branch}${o.pushed ? " (pushed)" : " (local only)"}`));
      console.log(C.dim(`       files:  ${o.filesChanged.map((f) => f.path).join(", ") || "none"}`));
      console.log(C.dim(`       ${o.summary.split("\n")[0]}`));
    }

    const run = await store.getRun(runId);
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
