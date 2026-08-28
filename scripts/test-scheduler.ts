/** Verifies the dependency scheduler against fakes - no API key, no sandboxes. */
import { createDb } from "../packages/db/src/index.ts";
import { InProcessBus } from "../packages/bus/src/index.ts";
import { Store } from "../apps/orchestrator/src/store.ts";
import { RunEngine } from "../apps/orchestrator/src/run-engine.ts";
import { LocalProvider } from "../packages/sandbox/src/index.ts";
import type { TaskGraph } from "../packages/protocol/src/index.ts";
import type { CodingEngine, CodingResult } from "../packages/agent-engine/src/index.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra ? "  | " + extra : ""}`);
  if (!cond) fail++;
};

const task = (id: string, role: any, dependsOn: string[] = []) => ({
  id, title: `do ${id}`, instruction: `implement ${id} completely`, role,
  dependsOn, touches: [], acceptance: [],
});

const graph: TaskGraph = {
  goal: "build a small app",
  contract: { summary: "REST API + UI", endpoints: [], tables: [], conventions: [] },
  tasks: [
    task("db-schema", "database"),
    task("api", "backend", ["db-schema"]),
    task("ui", "frontend", ["api"]),
    task("docs", "docs"),          // independent - must run in parallel with db-schema
  ],
};

/** Records ordering and concurrency; fails whichever task the test asks it to. */
class FakeEngine implements CodingEngine {
  readonly name = "fake";
  order: string[] = [];
  peakConcurrency = 0;
  #active = 0;
  constructor(private failTasks: Set<string> = new Set(), private delayMs = 60) {}
  async ensureInstalled() {}
  async runTask(_ctx: any, t: any): Promise<CodingResult> {
    this.order.push(t.taskId);
    this.#active++;
    this.peakConcurrency = Math.max(this.peakConcurrency, this.#active);
    await new Promise((r) => setTimeout(r, this.delayMs));
    this.#active--;
    const ok = !this.failTasks.has(t.taskId);
    return {
      ok,
      filesChanged: ok ? [{ path: `${t.taskId}.ts`, action: "created" as const }] : [],
      commits: ok ? [`abc123 ${t.title}`] : [],
      summary: ok ? `implemented ${t.taskId}` : `failed ${t.taskId}`,
      log: "",
    };
  }
}

/** A provider that skips real git; the scheduler is what is under test. */
class StubProvider extends LocalProvider {
  override async exec(id: string, cmd: string, opts?: any) {
    if (/^git clone/.test(cmd.trim())) return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
    if (/^git (rev-parse|checkout|log|diff|status|add|commit|push)/.test(cmd.trim())) {
      return { exitCode: 0, stdout: cmd.includes("rev-parse") ? "base000" : "", stderr: "", durationMs: 0 };
    }
    return super.exec(id, cmd, opts);
  }
}

const run = async (failTasks: Set<string> = new Set(), maxConcurrency?: number) => {
  // Ephemeral database: the scheduler is what is under test, and sharing the
  // development PGlite directory corrupts it.
  const db = await createDb("memory");
  const store = new Store(db);
  const bus = new InProcessBus();
  const engine = new FakeEngine(failTasks);
  const messages: string[] = [];
  bus.subscribeAll as any;

  const runEngine = new RunEngine(store, bus, {
    planOverride: async () => graph,
    createEngine: () => engine,
    createProvider: () => new StubProvider(),
    onEvent: (e) => { if (e.kind === "task") messages.push(`${e.taskId}:${e.status}`); },
  });

  const { runId, outcomes } = await runEngine.execute({
    goal: graph.goal, repoUrl: "https://example.invalid/repo.git", maxConcurrency,
  });
  await bus.close();
  return { runId, outcomes, engine, messages, store };
};

const main = async () => {
  console.log("\n\x1b[1mscheduler\x1b[0m\n");

  // --- happy path -------------------------------------------------------
  const a = await run(new Set(), 4);
  const order = a.engine.order;
  check("all 4 tasks ran", order.length === 4, order.join(" -> "));
  check("db-schema before api", order.indexOf("db-schema") < order.indexOf("api"), order.join(" -> "));
  check("api before ui", order.indexOf("api") < order.indexOf("ui"), order.join(" -> "));
  check("independent work ran in parallel", a.engine.peakConcurrency >= 2, `peak=${a.engine.peakConcurrency}`);
  check("all outcomes ok", [...a.outcomes.values()].every((o) => o.ok));

  const tasksInDb = await a.store.listTasks(a.runId);
  check("tasks persisted", tasksInDb.length === 4, `${tasksInDb.length} rows`);
  check("completed tasks are in review", tasksInDb.filter((t) => t.status === "review").length === 4,
    tasksInDb.map((t) => `${t.taskId}=${t.status}`).join(", "));

  const msgs = await a.store.listMessages(a.runId);
  check("bus traffic persisted", msgs.length > 0, `${msgs.length} messages`);
  check("PLAN_READY recorded", msgs.some((m) => m.type === "PLAN_READY"));
  check("TASK_ASSIGNED recorded", msgs.filter((m) => m.type === "TASK_ASSIGNED").length === 4);
  check("SCHEMA_READY broadcast by database worker", msgs.some((m) => m.type === "SCHEMA_READY"));
  check("API_READY broadcast by backend worker", msgs.some((m) => m.type === "API_READY"));

  // --- the master sizes the run when nobody asks for a number ----------
  console.log("\n\x1b[1mworkers chosen from the plan\x1b[0m\n");

  {
    // The graph is two levels wide at most (db-schema and docs), so a run that
    // names no concurrency should provision two workers, not one per task.
    const c = await run();
    check("every task still runs", c.engine.order.length === 4, c.engine.order.join(" -> "));
    check("the plan's width is used", c.engine.peakConcurrency === 2,
      `peak=${c.engine.peakConcurrency}`);

    const cMsgs = await c.store.listMessages(c.runId);
    const said = cMsgs.find((m) => m.content.includes("running up to"));
    check("the run says what it decided", Boolean(said), said?.content ?? "no such message");
  }

  // --- failure propagation ---------------------------------------------
  console.log("\n\x1b[1mfailure propagation\x1b[0m\n");
  const b = await run(new Set(["api"]), 4);
  const bTasks = await b.store.listTasks(b.runId);
  const status = Object.fromEntries(bTasks.map((t) => [t.taskId, t.status]));

  check("failed task marked failed", status["api"] === "failed", JSON.stringify(status));
  check("dependant is blocked, not attempted", status["ui"] === "blocked", `ui=${status["ui"]}`);
  check("ui never ran", !b.engine.order.includes("ui"), b.engine.order.join(" -> "));
  check("unrelated task still succeeded", status["docs"] === "review", `docs=${status["docs"]}`);
  check("run terminates (no hang)", true);

  const bMsgs = await b.store.listMessages(b.runId);
  check("BLOCKED message emitted", bMsgs.some((m) => m.type === "BLOCKED"));
  check("TASK_FAILED emitted", bMsgs.some((m) => m.type === "TASK_FAILED"));

  const bRun = await b.store.getRun(b.runId);
  check("run status reflects failures", bRun?.status === "completed_with_failures", String(bRun?.status));

  console.log(fail === 0 ? "\n\x1b[32mALL PASS\x1b[0m\n" : `\n\x1b[31m${fail} FAILURE(S)\x1b[0m\n`);
  process.exit(fail === 0 ? 0 : 1);
};

main().catch((e) => { console.error(e); process.exit(1); });
