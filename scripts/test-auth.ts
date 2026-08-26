/**
 * Ownership: who can see which runs.
 *
 * The interesting failure here is not "a stranger got in" - that is the easy
 * case - but "a signed-in user saw someone else's work". Two places decide it:
 * the store, which scopes reads, and the event hub, which fans out the live
 * feed. Both are exercised directly.
 */
import { authMode, LOCAL_USER } from "../apps/orchestrator/src/auth.ts";
import { EventHub } from "../apps/orchestrator/src/events.ts";
import { Store } from "../apps/orchestrator/src/store.ts";
import { createDb } from "../packages/db/src/index.ts";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "\x1b[32mok  \x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${extra ? `  | ${extra}` : ""}`);
  if (!cond) failures++;
};

const seed = (store: Store, id: string, userId?: string) =>
  store.createRun({
    id, userId, goal: `goal ${id}`, repoUrl: "https://github.com/acme/widget.git",
    baseBranch: "main", integrationBranch: `kapi/${id}/integration`, sandboxProvider: "local",
  });

const main = async () => {
  console.log("\n\x1b[1mauth mode\x1b[0m\n");

  check("defaults to none without WorkOS", authMode({} as NodeJS.ProcessEnv) === "none",
    "the zero-config quick start must keep working");
  check("defaults to workos once configured",
    authMode({ WORKOS_CLIENT_ID: "c", WORKOS_API_KEY: "k" } as NodeJS.ProcessEnv) === "workos",
    "configuring WorkOS is a deliberate act");
  check("explicit none wins over configuration",
    authMode({ KAPI_AUTH_MODE: "none", WORKOS_CLIENT_ID: "c", WORKOS_API_KEY: "k" } as NodeJS.ProcessEnv) === "none");
  check("local operator has a stable id", LOCAL_USER.id === "local");

  console.log("\n\x1b[1mrun ownership\x1b[0m\n");

  const store = new Store(await createDb("memory"));
  await store.upsertUser({ id: "user-a", email: "a@example.com" });
  await store.upsertUser({ id: "user-b", email: "b@example.com" });
  await seed(store, "run-a1", "user-a");
  await seed(store, "run-a2", "user-a");
  await seed(store, "run-b1", "user-b");
  await seed(store, "run-cli");

  const a = await store.listRuns("user-a");
  check("a user sees only their runs", a.length === 2, a.map((r) => r.id).join(", "));
  check("and not the other user's", !a.some((r) => r.id === "run-b1"));
  check("and not unowned CLI runs", !a.some((r) => r.id === "run-cli"));

  const all = await store.listRuns();
  check("unscoped listing still sees everything", all.length === 4, `${all.length} runs`);

  check("cannot fetch another user's run by id", await store.getRun("run-b1", "user-a") === null,
    "a 404, not a 403 - existence is itself private");
  check("can fetch own run by id", (await store.getRun("run-a1", "user-a"))?.id === "run-a1");
  check("unscoped fetch still works", (await store.getRun("run-b1"))?.id === "run-b1");

  check("upsertUser is idempotent", await (async () => {
    await store.upsertUser({ id: "user-a", email: "changed@example.com" });
    return (await store.listRuns("user-a")).length === 2;
  })());

  console.log("\n\x1b[1mlive feed fan-out\x1b[0m\n");

  const hub = new EventHub();
  hub.register("run-a1", "user-a");
  hub.register("run-b1", "user-b");

  const received: Record<string, string[]> = { a: [], b: [], unscoped: [] };
  hub.add({ runId: null, userId: "user-a", send: (d) => received.a.push(d) });
  hub.add({ runId: null, userId: "user-b", send: (d) => received.b.push(d) });
  hub.add({ runId: null, userId: undefined, send: (d) => received.unscoped.push(d) });

  hub.publish({ kind: "status", runId: "run-a1", status: "planning" });
  hub.publish({ kind: "status", runId: "run-b1", status: "planning" });

  check("each user sees their own run", received.a.length === 1 && received.b.length === 1,
    `a=${received.a.length} b=${received.b.length}`);
  check("user A did not see run-b1", !received.a.join("").includes("run-b1"));
  check("user B did not see run-a1", !received.b.join("").includes("run-a1"));
  check("single-operator listener sees everything", received.unscoped.length === 2,
    "no authentication means one user");

  // A run nobody claimed must not leak to an authenticated subscriber.
  hub.publish({ kind: "status", runId: "run-unregistered", status: "planning" });
  check("unregistered runs stay hidden from scoped listeners",
    received.a.length === 1 && received.b.length === 1, "fail closed");

  // Replay on join is the other path into the hub, and it is easy to forget.
  const late: string[] = [];
  hub.add({ runId: "run-b1", userId: "user-a", send: (d) => late.push(d) });
  check("replay does not leak another user's history", late.length === 0,
    `${late.length} replayed event(s)`);

  const own: string[] = [];
  hub.add({ runId: "run-a1", userId: "user-a", send: (d) => own.push(d) });
  check("replay still works for your own run", own.length === 1, `${own.length} replayed event(s)`);

  console.log(failures === 0 ? "\n\x1b[32mALL PASS\x1b[0m\n" : `\n\x1b[31m${failures} FAILED\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
};

await main();
