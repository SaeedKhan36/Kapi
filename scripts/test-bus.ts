import { InProcessBus, AgentChannel } from "../packages/bus/src/index.ts";
import { workerId } from "../packages/protocol/src/index.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra ? "  | " + extra : ""}`);
  if (!cond) fail++;
};
const settle = () => new Promise((r) => setTimeout(r, 20));

const run = async () => {
  const bus = new InProcessBus();
  const RUN = "run-1";

  const master = new AgentChannel(bus, RUN, "master", 300);
  const fe = new AgentChannel(bus, RUN, workerId("frontend"), 300);
  const be = new AgentChannel(bus, RUN, workerId("backend"), 300);

  const seen: Record<string, string[]> = { master: [], fe: [], be: [] };
  master.onMessage((m) => seen.master.push(`${m.from}->${m.to}:${m.type}`));
  fe.onMessage((m) => seen.fe.push(`${m.from}->${m.to}:${m.type}`));
  be.onMessage((m) => seen.be.push(`${m.from}->${m.to}:${m.type}`));

  // 1. direct worker -> worker delivery, without the master relaying
  await fe.send(workerId("backend"), "QUERY", "what shape is /api/users?");
  await settle();
  check("worker->worker delivered directly", seen.be.some((s) => s.includes("QUERY")), seen.be.join(", "));
  check("sender does not receive its own message", seen.fe.length === 0, seen.fe.join(", "));

  // 2. master observes traffic it is not addressed in
  check("master observes worker->worker traffic", seen.master.some((s) => s.includes("QUERY")), seen.master.join(", "));

  // 3. broadcast reaches everyone but the sender
  seen.master.length = seen.fe.length = seen.be.length = 0;
  await master.send("broadcast", "SCHEMA_READY", "schema is live");
  await settle();
  check("broadcast reaches frontend", seen.fe.some((s) => s.includes("SCHEMA_READY")));
  check("broadcast reaches backend", seen.be.some((s) => s.includes("SCHEMA_READY")));
  check("broadcast not echoed to sender", !seen.master.some((s) => s.includes("SCHEMA_READY")));

  // 4. no duplicate delivery (direct + broadcast paths both fire internally)
  seen.be.length = 0;
  await master.send(workerId("backend"), "TASK_ASSIGNED", "build it");
  await settle();
  check("no duplicate delivery", seen.be.filter((s) => s.includes("TASK_ASSIGNED")).length === 1,
    `count=${seen.be.filter((s) => s.includes("TASK_ASSIGNED")).length}`);

  // 5. ask/reply correlation
  be.onMessage(async (m) => {
    if (m.type === "QUERY") await be.reply(m, "QUERY_RESPONSE", "{id, email}");
  });
  const answer = await fe.ask(workerId("backend"), "QUERY", "user shape?");
  check("ask resolves with correlated reply", answer?.content === "{id, email}", String(answer?.content));
  check("reply carries replyTo", Boolean(answer?.replyTo));

  // 6. THE deadlock guard: asking a silent agent times out instead of hanging
  const t0 = Date.now();
  const silent = await fe.ask(workerId("ghost"), "QUERY", "anyone there?");
  const waited = Date.now() - t0;
  check("ask against silent agent times out (no deadlock)", silent === null, `waited ${waited}ms`);
  check("timeout respects configured window", waited >= 250 && waited < 1500, `${waited}ms`);

  // 7. run isolation
  const other = new AgentChannel(bus, "run-2", workerId("backend"), 300);
  const otherSeen: string[] = [];
  other.onMessage((m) => otherSeen.push(m.type));
  await master.send("broadcast", "PLAN_READY", "plan for run-1");
  await settle();
  check("runs are isolated", otherSeen.length === 0, otherSeen.join(","));

  await Promise.all([master.close(), fe.close(), be.close(), other.close()]);
  await bus.close();

  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURE(S)`);
  process.exit(fail === 0 ? 0 : 1);
};
run();
