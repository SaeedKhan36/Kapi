import { loadEnv } from "@kapi/env";
loadEnv();

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { createDb, describeDbTarget } from "@kapi/db";
import { createMessageBus } from "@kapi/bus";
import { Store } from "./store.ts";
import { RunEngine } from "./run-engine.ts";
import { EventHub } from "./events.ts";

const CreateRunSchema = z.object({
  goal: z.string().min(5),
  repoUrl: z.string().url(),
  baseBranch: z.string().default("main"),
  maxConcurrency: z.number().int().min(1).max(16).default(4),
  maxTasks: z.number().int().min(1).max(12).optional(),
  providerName: z.enum(["local", "docker", "daytona"]).optional(),
});

const db = await createDb();
const store = new Store(db);
const bus = createMessageBus();
const hub = new EventHub();
const engine = new RunEngine(store, bus, { onEvent: (e) => hub.publish(e) });

const app = new Hono();
app.use("/api/*", cors());

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    database: describeDbTarget(),
    provider: process.env.SANDBOX_PROVIDER ?? "local",
    llmConfigured: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GROQ_API_KEY || process.env.CEREBRAS_API_KEY),
    pushEnabled: Boolean(process.env.GITHUB_TOKEN),
    clients: hub.clientCount,
  }),
);

app.get("/api/runs", async (c) => c.json(await store.listRuns()));

app.get("/api/runs/:id", async (c) => {
  const id = c.req.param("id");
  const run = await store.getRun(id);
  if (!run) return c.json({ error: "run not found" }, 404);
  const [tasks, agents, messages, artifacts] = await Promise.all([
    store.listTasks(id), store.listAgents(id), store.listMessages(id), store.listArtifacts(id),
  ]);
  return c.json({ run, tasks, agents, messages, artifacts });
});

app.post("/api/runs", async (c) => {
  const parsed = CreateRunSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
  }

  // Runs take minutes. Resolve as soon as the run row exists, then let the
  // engine continue in the background and stream progress over the websocket.
  try {
    const runId = await new Promise<string>((resolve, reject) => {
      let started = false;
      engine
        .execute({
          ...parsed.data,
          onStart: (id) => { started = true; resolve(id); },
        })
        .catch((err) => {
          if (started) console.error(`[run] failed:`, err);
          else reject(err);
        });
    });
    return c.json({ runId }, 202);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

const port = Number(process.env.ORCHESTRATOR_PORT ?? 8787);
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`\n  kapi orchestrator`);
  console.log(`  http  http://localhost:${port}`);
  console.log(`  ws    ws://localhost:${port}/ws`);
  console.log(`  db    ${describeDbTarget()}`);
  console.log(`  llm   ${process.env.GEMINI_API_KEY ? "configured" : "NOT configured - set GEMINI_API_KEY"}\n`);
});

const wss = new WebSocketServer({ server: server as never, path: "/ws" });
wss.on("connection", (socket, req) => {
  const runId = new URL(req.url ?? "/", "http://localhost").searchParams.get("runId");
  const remove = hub.add({ runId, send: (data) => socket.send(data) });
  socket.on("close", remove);
  socket.on("error", remove);
});

const shutdown = async () => {
  await bus.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
