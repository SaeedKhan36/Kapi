/**
 * Verifies the master rewrites the plan when a task fails: retry, rescope,
 * abandon, dependency remapping, and the bounds that stop it looping.
 * Scripted LLM, stubbed git — no network, no quota.
 */
import { createDb } from "../packages/db/src/index.ts";
import { InProcessBus } from "../packages/bus/src/index.ts";
import { Store } from "../apps/orchestrator/src/store.ts";
import { RunEngine } from "../apps/orchestrator/src/run-engine.ts";
import { LocalProvider } from "../packages/sandbox/src/index.ts";
import {
  validateRecovery, remapDependencies, applyRecovery,
  type RecoveryDecision, type TaskGraph,
} from "../packages/protocol/src/index.ts";
import type { CodingEngine, CodingResult } from "../packages/agent-engine/src/index.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra ? "  | " + extra : ""}`);
  if (!cond) fail++;
};

const task = (id: string, role: any = "backend", dependsOn: string[] = []) => ({
  id, title: `do ${id}`, instruction: `implement ${id}`, role,
  dependsOn, touches: [], acceptance: [],
});

console.log("\n\x1b[1mrecovery validation\x1b[0m\n");

const existing = new Set(["api", "ui"]);
const base: RecoveryDecision = { strategy: "abandon", reasoning: "r", replacementTasks: [], dependantsCanProceed: false };

check("retry without guidance rejected",
  validateRecovery({ ...base, strategy: "retry" }, "api", existing).length > 0);
check("retry with guidance accepted",
  validateRecovery({ ...base, strategy: "retry", guidance: "read the file first" }, "api", existing).length === 0);
check("rescope with no replacements rejected",
  validateRecovery({ ...base, strategy: "rescope" }, "api", existing).length > 0);
check("replacement colliding with a live task rejected",
  validateRecovery({ ...base, strategy: "rescope", replacementTasks: [task("ui")] }, "api", existing)
    .some((p) => p.detail.includes("collides")));
check("replacement reusing the failed id rejected",
  validateRecovery({ ...base, strategy: "rescope", replacementTasks: [task("api")] }, "api", existing)
    .some((p) => p.detail.includes("reuses")));
check("replacement depending on the replaced task rejected",
  validateRecovery({ ...base, strategy: "rescope", replacementTasks: [task("api-a", "backend", ["api"])] }, "api", existing)
    .some((p) => p.detail.includes("depends on the failed task")));
check("replacement depending on an unknown task rejected",
  validateRecovery({ ...base, strategy: "rescope", replacementTasks: [task("api-a", "backend", ["ghost"])] }, "api", existing)
    .some((p) => p.detail.includes("unknown")));
check("siblings may depend on each other",
  validateRecovery({ ...base, strategy: "rescope",
    replacementTasks: [task("api-a"), task("api-b", "backend", ["api-a"])] }, "api", existing).length === 0);

const remapped = remapDependencies([task("ui", "frontend", ["api"])], "api", ["api-a", "api-b"]);
check("dependants remapped to replacements",
  remapped[0].dependsOn.join() === "api-a,api-b", remapped[0].dependsOn.join());

const graph: TaskGraph = {
  goal: "g", contract: { summary: "s", endpoints: [], tables: [], conventions: [] },
  tasks: [task("api"), task("ui", "frontend", ["api"])],
};
const applied = applyRecovery(graph, "api", {
  ...base, strategy: "rescope", replacementTasks: [task("api-a"), task("api-b")],
});
check("replaced task removed from graph", !applied.some((t) => t.id === "api"));
check("replacements added", applied.filter((t) => t.id.startsWith("api-")).length === 2);
check("dependant now waits on replacements",
  applied.find((t) => t.id === "ui")!.dependsOn.join() === "api-a,api-b");

console.log("\n\x1b[1mlive scheduler\x1b[0m\n");

/** Fails listed tasks until their Nth attempt. */
class FlakyEngine implements CodingEngine {
  readonly name = "flaky";
  runs: string[] = [];
  instructions: string[] = [];
  constructor(private failUntil: Record<string, number> = {}) {}
  async ensureInstalled() {}
  async runTask(_ctx: any, t: any): Promise<CodingResult> {
    this.runs.push(t.taskId);
    this.instructions.push(t.instruction);
    const seen = this.runs.filter((r) => r === t.taskId).length;
    const ok = seen >= (this.failUntil[t.taskId] ?? 0);
    return {
      ok, incomplete: !ok,
      filesChanged: ok ? [{ path: `${t.taskId}.ts`, action: "created" as const }] : [],
      commits: ok ? [`c ${t.taskId}`] : [],
      summary: ok ? `did ${t.taskId}` : `failed ${t.taskId}: ran out of steps`,
      log: "some log output",
    };
  }
}

class StubProvider extends LocalProvider {
  override async exec(id: string, cmd: string, opts?: any) {
    if (/^git |^rm -rf/.test(cmd.trim())) {
      return { exitCode: 0, stdout: cmd.includes("rev-parse") ? "base000" : "", stderr: "", durationMs: 0 };
    }
    return super.exec(id, cmd, opts);
  }
}

/** Returns scripted recovery decisions in order. */
const scriptedLlm = (decisions: RecoveryDecision[]) => {
  let i = 0;
  return {
    name: "scripted", isAvailable: () => true, modelFor: () => "scripted",
    available: [{ name: "scripted" }],
    usage: () => ({ requests: i, inputTokens: 0, outputTokens: 0, totalTokens: 0, maxRequests: 99, maxTokens: 99 }),
    generate: async () => { throw new Error("unused"); },
    generateStructured: async (_m: any, schema: any) => ({
      value: schema.parse(decisions[Math.min(i++, decisions.length - 1)]),
      usage: { inputTokens: 1, outputTokens: 1, requests: 1 }, model: "scripted", provider: "scripted",
    }),
  } as any;
};

const runWith = async (
  plan: TaskGraph, engine: FlakyEngine, decisions: RecoveryDecision[],
  opts: { maxRecoveries?: number; maxAttemptsPerTask?: number } = {},
) => {
  const store = new Store(await createDb("memory"));
  const bus = new InProcessBus();
  const events: string[] = [];
  const redistributions: string[] = [];

  const runEngine = new RunEngine(store, bus, {
    planOverride: async () => JSON.parse(JSON.stringify(plan)),
    createEngine: () => engine,
    createProvider: () => new StubProvider(),
    createLlm: () => scriptedLlm(decisions),
    onEvent: (e) => {
      if (e.kind === "task") events.push(`${e.taskId}:${e.status}`);
      if (e.kind === "redistribute") redistributions.push(`${e.taskId}:${e.strategy}`);
    },
  });

  const { runId } = await runEngine.execute({
    goal: plan.goal, repoUrl: "https://example.invalid/r.git",
    maxConcurrency: 3, skipReview: true, ...opts,
  });
  await bus.close();
  return { runId, store, engine, events, redistributions };
};

const diamond = (): TaskGraph => ({
  goal: "build it",
  contract: { summary: "s", endpoints: [], tables: [], conventions: [] },
  tasks: [task("api"), task("ui", "frontend", ["api"]), task("docs", "docs")],
});

// --- retry -----------------------------------------------------------
{
  const engine = new FlakyEngine({ api: 2 }); // succeeds on 2nd attempt
  const r = await runWith(diamond(), engine, [
    { strategy: "retry", reasoning: "ran out of steps", guidance: "write the file before testing", replacementTasks: [], dependantsCanProceed: false },
  ]);
  const apiRuns = engine.runs.filter((x) => x === "api").length;
  check("failed task retried once", apiRuns === 2, `${apiRuns} attempts`);
  check("retry recorded as a redistribution", r.redistributions.includes("api:retry"), r.redistributions.join(","));
  check("guidance reached the worker",
    engine.instructions.some((i) => i.includes("write the file before testing")));
  check("dependant ran after the retry succeeded", engine.runs.includes("ui"), engine.runs.join(" -> "));
  const statuses = Object.fromEntries((await r.store.listTasks(r.runId)).map((t) => [t.taskId, t.status]));
  check("retried task ends in review", statuses["api"] === "review", JSON.stringify(statuses));
}

// --- rescope ---------------------------------------------------------
{
  const engine = new FlakyEngine({ api: 99 }); // api never succeeds
  const r = await runWith(diamond(), engine, [
    { strategy: "rescope", reasoning: "task was two jobs in one",
      replacementTasks: [task("api-routes"), task("api-handlers")],
      dependantsCanProceed: false },
  ]);
  check("replacements were dispatched",
    engine.runs.includes("api-routes") && engine.runs.includes("api-handlers"), engine.runs.join(" -> "));
  check("rescope recorded", r.redistributions.includes("api:rescope"));
  check("dependant ran after replacements succeeded", engine.runs.includes("ui"), engine.runs.join(" -> "));
  const statuses = Object.fromEntries((await r.store.listTasks(r.runId)).map((t) => [t.taskId, t.status]));
  check("replaced task marked cancelled", statuses["api"] === "cancelled", JSON.stringify(statuses));
  check("replacement rows persisted", statuses["api-routes"] === "review", JSON.stringify(statuses));
}

// --- abandon, dependants blocked -------------------------------------
{
  const engine = new FlakyEngine({ api: 99 });
  const r = await runWith(diamond(), engine, [
    { strategy: "abandon", reasoning: "needs a credential we do not have", replacementTasks: [], dependantsCanProceed: false },
  ]);
  check("abandoned task not retried", engine.runs.filter((x) => x === "api").length === 1);
  check("dependant blocked", r.events.includes("ui:blocked"), r.events.join(","));
  check("unrelated task still ran", engine.runs.includes("docs"));
}

// --- abandon, dependants released ------------------------------------
{
  const engine = new FlakyEngine({ api: 99 });
  const r = await runWith(diamond(), engine, [
    { strategy: "abandon", reasoning: "optional enhancement", replacementTasks: [], dependantsCanProceed: true },
  ]);
  check("released dependant still ran", engine.runs.includes("ui"), engine.runs.join(" -> "));
  check("dependant not blocked", !r.events.includes("ui:blocked"), r.events.join(","));
}

// --- bounds ----------------------------------------------------------
{
  const engine = new FlakyEngine({ api: 99, ui: 99, docs: 99 });
  const r = await runWith(diamond(), engine, [
    { strategy: "retry", reasoning: "again", guidance: "try differently", replacementTasks: [], dependantsCanProceed: false },
  ], { maxRecoveries: 1 });
  const abandonedForBudget = r.redistributions.filter((x) => x.endsWith(":abandon")).length;
  check("recovery budget enforced", abandonedForBudget >= 1, r.redistributions.join(","));
  check("run terminated despite repeated failure", true);
}

{
  const engine = new FlakyEngine({ api: 99 });
  const r = await runWith(diamond(), engine, [
    { strategy: "retry", reasoning: "again", guidance: "try differently", replacementTasks: [], dependantsCanProceed: false },
  ], { maxAttemptsPerTask: 2, maxRecoveries: 5 });
  const apiRuns = engine.runs.filter((x) => x === "api").length;
  check("per-task attempts bounded", apiRuns === 2, `${apiRuns} attempts`);
}

// --- an unusable decision must not corrupt the graph ------------------
{
  const engine = new FlakyEngine({ api: 99 });
  const r = await runWith(diamond(), engine, [
    // rescope whose replacement collides with a live task
    { strategy: "rescope", reasoning: "bad plan", replacementTasks: [task("docs")], dependantsCanProceed: false },
  ]);
  check("invalid rescope degrades to abandon", r.redistributions.includes("api:abandon"), r.redistributions.join(","));
  check("colliding replacement never dispatched twice",
    engine.runs.filter((x) => x === "docs").length === 1, engine.runs.join(" -> "));
}

console.log(fail === 0 ? "\n\x1b[32mALL PASS\x1b[0m\n" : `\n\x1b[31m${fail} FAILURE(S)\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
