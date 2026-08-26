/**
 * Does the Redis bus actually carry a message between two instances?
 *
 * This is the property the bus exists for and the one that cannot be inferred
 * from configuration tests: two orchestrators, one run, a message published on
 * one and delivered on the other. Run against a minimal RESP server rather
 * than a real Redis so it needs no Docker and no network.
 */
import { RedisBus } from "../packages/bus/src/redis.ts";
import type { AgentMessage } from "../packages/protocol/src/index.ts";
import { startFakeRedis } from "./fake-redis.ts";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "\x1b[32mok  \x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${extra ? `  | ${extra}` : ""}`);
  if (!cond) failures++;
};

const message = (runId: string, to: string, content: string): AgentMessage => ({
  id: `${runId}-${content}`,
  runId,
  from: "master",
  to: to as AgentMessage["to"],
  type: "LOG",
  content,
  ts: new Date().toISOString(),
});

/** Waits for a condition, so the test is not a race against the event loop. */
const until = async (predicate: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
};

const main = async () => {
  console.log("\n\x1b[1mredis bus\x1b[0m\n");

  const redis = await startFakeRedis();

  // Two buses on one Redis: the two orchestrator instances.
  const alpha = new RedisBus(redis.url);
  const beta = new RedisBus(redis.url);

  try {
    await alpha.ready();
    await beta.ready();
    check("ready() connects", true, `${redis.clients()} client connections`);
    check("each bus opens a publisher and a subscriber", redis.clients() === 4,
      `${redis.clients()} connections`);

    // --- a message crosses between instances --------------------------------
    const seen: string[] = [];
    beta.subscribeAll("run-1", (m) => seen.push(m.content));
    // subscribeAll is synchronous by contract; the SUBSCRIBE round trip is not.
    await until(() => redis.clients() === 4);
    await new Promise((r) => setTimeout(r, 150));

    await alpha.publish(message("run-1", "broadcast", "hello-from-alpha"));
    check("a message published on one bus arrives on the other",
      await until(() => seen.includes("hello-from-alpha")), seen.join(", ") || "nothing arrived");

    // --- addressing survives the round trip ---------------------------------
    const backend: string[] = [];
    const frontend: string[] = [];
    beta.subscribe("run-2", "worker:backend", (m) => backend.push(m.content));
    beta.subscribe("run-2", "worker:frontend", (m) => frontend.push(m.content));
    await new Promise((r) => setTimeout(r, 150));

    await alpha.publish(message("run-2", "worker:backend", "for-backend"));
    check("a directed message reaches its addressee",
      await until(() => backend.includes("for-backend")), backend.join(", ") || "nothing arrived");
    check("...and not the other agent", !frontend.includes("for-backend"),
      frontend.join(", ") || "clean");

    await alpha.publish(message("run-2", "broadcast", "for-everyone"));
    check("a broadcast reaches every agent on the run",
      await until(() => backend.includes("for-everyone") && frontend.includes("for-everyone")),
      `backend=[${backend}] frontend=[${frontend}]`);

    // --- runs are isolated from each other ----------------------------------
    const otherRun: string[] = [];
    beta.subscribeAll("run-3", (m) => otherRun.push(m.content));
    await new Promise((r) => setTimeout(r, 150));
    await alpha.publish(message("run-1", "broadcast", "run-1-only"));
    await new Promise((r) => setTimeout(r, 250));
    check("a message does not leak into another run", !otherRun.includes("run-1-only"),
      otherRun.join(", ") || "clean");

    // --- the local mirror still works for same-instance delivery -------------
    const local: string[] = [];
    alpha.subscribeAll("run-4", (m) => local.push(m.content));
    await new Promise((r) => setTimeout(r, 150));
    await alpha.publish(message("run-4", "broadcast", "same-instance"));
    check("delivery within one instance still works",
      await until(() => local.includes("same-instance")), local.join(", ") || "nothing arrived");
  } finally {
    await alpha.close().catch(() => {});
    await beta.close().catch(() => {});
    await redis.close();
  }

  // --- an unreachable server is a boot failure, not a silent one ------------
  const dead = new RedisBus("redis://127.0.0.1:1");
  let refused = false;
  try {
    await dead.ready();
  } catch {
    refused = true;
  }
  await dead.close().catch(() => {});
  check("ready() rejects when Redis is unreachable", refused,
    "otherwise a multi-instance deployment comes up deaf");

  console.log(failures === 0 ? "\n\x1b[32mALL PASS\x1b[0m\n" : `\n\x1b[31m${failures} FAILED\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
};

await main();
