import { loadEnv } from "@kapi/env";
loadEnv();

import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors as honoCors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { createDb, describeDbTarget } from "@kapi/db";
import { createMessageBus, readyMessageBus, RedisBus } from "@kapi/bus";
import {
  createRepoAccess, githubAppConfigured, listBranches, listRepositories,
  parseRepoUrl, IdentityError,
} from "@kapi/identity";
import { Store } from "./store.ts";
import { RunEngine, RunNotAuthorizedError } from "./run-engine.ts";
import { EventHub } from "./events.ts";
import { createAuth, providerAllowed, type AuthedEnv } from "./auth.ts";
import { allowCorsOrigin, corsPolicy } from "./cors.ts";
import { createLimits } from "./limits.ts";
import { WsTicketStore } from "./ws-tickets.ts";
import { sharedSandboxLimiter } from "@kapi/sandbox";
import { repoAccessFor } from "./github-routes.ts";

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
// Constructing throws immediately on a misconfigured KAPI_BUS=redis; connecting
// catches an unreachable server or a wrong password. Both belong at boot: a bus
// that fails later does not look like a failure, it looks like agents that
// stopped hearing each other halfway through a run.
const bus = createMessageBus();
await readyMessageBus(bus);
const hub = new EventHub();
const auth = createAuth(store);
const limits = createLimits();
const tickets = new WsTicketStore();
const corsAllow = corsPolicy(process.env, auth.mode);
const sandboxes = sharedSandboxLimiter();
const engine = new RunEngine(store, bus, { onEvent: (e) => hub.publish(e) });

/** In single-operator mode there is one user, so scoping reads is meaningless. */
const scope = (userId: string) => (auth.mode === "none" ? undefined : userId);

const app = new Hono<AuthedEnv>();
app.use("/api/*", honoCors({
  origin: (origin) => allowCorsOrigin(origin, corsAllow) ?? "",
  credentials: true,
}));

// Health describes the deployment and must answer before anyone has signed in.
app.get("/api/health", (c) =>
  c.json({
    ok: true,
    database: describeDbTarget(),
    provider: process.env.SANDBOX_PROVIDER ?? "local",
    llmConfigured: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GROQ_API_KEY || process.env.CEREBRAS_API_KEY),
    auth: auth.mode,
    githubApp: githubAppConfigured(),
    pushEnabled: Boolean(process.env.GITHUB_TOKEN) || githubAppConfigured(),
    clients: hub.clientCount,
    // What this process will and will not spend, and where it currently sits.
    // Worth publishing: a run refused as rate-limited is otherwise
    // indistinguishable from one refused for any other reason.
    limits: {
      runsPerHour: limits.rate.perHour,
      burst: limits.rate.burst,
      concurrentRuns: `${limits.runs.active}/${limits.runs.maxTotal}`,
      concurrentRunsPerUser: limits.runs.maxPerUser,
      sandboxes: `${sandboxes.active}/${sandboxes.max}`,
      sandboxesWaiting: sandboxes.waiting,
    },
  }),
);

app.use("/api/*", auth.middleware);

/**
 * A handle the browser can put on the WebSocket URL instead of its session
 * JWT. Issued over HTTP so the token stays in an Authorization header; spent
 * at the upgrade. See `WsTicketStore`.
 */
app.post("/api/ws-tickets", async (c) => {
  const runId = c.req.query("runId") || null;
  return c.json(tickets.issue(c.get("user").id, runId));
});

app.get("/api/me", async (c) => {
  const user = c.get("user");
  const connected = auth.identity
    ? await auth.identity.isGithubConnected(user.id, user.organizationId)
    : Boolean(process.env.GITHUB_TOKEN);

  return c.json({
    user,
    github: {
      connected,
      connectUrl: "/api/github/connect",
      // Clerk collects the grant in its own account UI, so the dashboard opens
      // that in place rather than navigating away to a server route.
      inApp: auth.identity?.name === "clerk",
    },
    githubApp: githubAppConfigured(),
  });
});

// ------------------------------------------------------------------- GitHub

/** Starts (or repairs) the user's GitHub connection. */
app.get("/api/github/connect", async (c) => {
  if (!auth.identity) return c.json({ error: "GitHub connection requires a login provider" }, 501);
  const user = c.get("user");
  try {
    const url = await auth.identity.githubAuthorizationUrl({
      userId: user.id,
      organizationId: user.organizationId,
      returnTo: c.req.query("returnTo"),
    });
    // Null means the provider owns the flow client-side; say so rather than
    // redirecting the browser somewhere that cannot finish it.
    if (!url) {
      return c.json({
        error: "Connect GitHub from your account settings.",
        code: "GITHUB_CONNECT_IN_APP",
      }, 400);
    }
    return c.redirect(url);
  } catch (err) {
    return githubError(c, err);
  }
});

app.get("/api/github/repos", async (c) => {
  try {
    return c.json({ repositories: await listRepositories(await userToken(c)) });
  } catch (err) {
    return githubError(c, err);
  }
});

app.get("/api/github/repos/:owner/:repo/branches", async (c) => {
  const ref = { owner: c.req.param("owner"), repo: c.req.param("repo") };
  try {
    return c.json({ branches: await listBranches(await userToken(c), ref) });
  } catch (err) {
    return githubError(c, err);
  }
});

/**
 * Whether a run against this repository would be allowed, without starting one.
 *
 * Lets the UI show an "install the app" call to action before the user has
 * written a goal, rather than after they have waited for a run to be refused.
 */
app.get("/api/github/repos/:owner/:repo/authorization", async (c) => {
  const { owner, repo } = c.req.param();
  try {
    const access = await repoAccessFor(auth, c.get("user"));
    const decision = await access.authorize(`https://github.com/${owner}/${repo}.git`);
    return c.json(decision);
  } catch (err) {
    return githubError(c, err);
  }
});

// --------------------------------------------------------------------- runs

app.get("/api/runs", async (c) => c.json(await store.listRuns(scope(c.get("user").id))));

app.get("/api/runs/:id", async (c) => {
  const id = c.req.param("id");
  const run = await store.getRun(id, scope(c.get("user").id));
  // Someone else's run is "not found", not "forbidden": whether a given id
  // exists is itself something the caller is not entitled to learn.
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
  if (!parseRepoUrl(parsed.data.repoUrl)) {
    return c.json({ error: "repoUrl must be a GitHub repository" }, 400);
  }

  if (!providerAllowed(auth.mode, parsed.data.providerName)) {
    return c.json({
      error: "the local sandbox provider is not available on a multi-user deployment",
      code: "PROVIDER_NOT_ALLOWED",
    }, 403);
  }

  const user = c.get("user");

  // Cheapest check first: refusing a rate-limited caller must not cost a
  // GitHub round trip, or the limit becomes its own amplification.
  const rate = limits.rate.take(user.id);
  if (!rate.ok) {
    c.header("retry-after", String(rate.retryAfterSeconds));
    return c.json({
      error: rate.reason,
      code: "RATE_LIMITED",
      retryAfterSeconds: rate.retryAfterSeconds,
    }, 429);
  }

  const slot = limits.runs.admit(user.id);
  if (!slot.ok) {
    return c.json({ error: slot.reason, code: "TOO_MANY_RUNS" }, 429);
  }

  let repoAccess;
  try {
    repoAccess = await repoAccessFor(auth, user);
  } catch (err) {
    slot.release();
    return githubError(c, err);
  }

  // Runs take minutes. Resolve as soon as the run row exists, then let the
  // engine continue in the background and stream progress over the websocket.
  try {
    const runId = await new Promise<string>((resolve, reject) => {
      let started = false;
      new RunEngine(store, bus, { onEvent: (e) => hub.publish(e), repoAccess })
        .execute({
          ...parsed.data,
          userId: user.id,
          onStart: (id) => {
            started = true;
            hub.register(id, scope(user.id));
            resolve(id);
          },
        })
        // The slot is held for the life of the run, not the request, and is
        // released on every exit path - a leaked one would permanently shrink
        // what this orchestrator can accept.
        .catch((err) => {
          if (started) console.error(`[run] failed:`, err);
          else reject(err);
        })
        .finally(() => slot.release());
    });
    return c.json({ runId }, 202);
  } catch (err) {
    if (err instanceof RunNotAuthorizedError) {
      return c.json({
        error: err.message,
        code: err.action === "denied" ? "REPO_ACCESS_DENIED" : "APP_NOT_INSTALLED",
        action: err.action,
        installUrl: err.installUrl,
      }, 403);
    }
    return githubError(c, err);
  }
});

/** The caller's own GitHub token, for reads the orchestrator makes on their behalf. */
async function userToken(c: Context<AuthedEnv>): Promise<string> {
  const user = c.get("user");
  if (!auth.identity) {
    const pat = process.env.GITHUB_TOKEN;
    if (!pat) throw new IdentityError("Set GITHUB_TOKEN to browse repositories.", 401, "GITHUB_NOT_CONNECTED");
    return pat;
  }
  return auth.identity.githubTokenFor(user.id, user.organizationId);
}

/** Turns a GitHub or login-provider failure into a response the UI can act on. */
function githubError(c: Context<AuthedEnv>, err: unknown) {
  if (err instanceof IdentityError) {
    return c.json({ error: err.message, code: err.code }, err.status as ContentfulStatusCode);
  }
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
}

const port = Number(process.env.ORCHESTRATOR_PORT ?? 8787);
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`\n  kapi orchestrator`);
  console.log(`  http  http://localhost:${port}`);
  console.log(`  ws    ws://localhost:${port}/ws`);
  console.log(`  db    ${describeDbTarget()}`);
  console.log(`  llm   ${process.env.GEMINI_API_KEY ? "configured" : "NOT configured - set GEMINI_API_KEY"}`);
  console.log(`  bus   ${bus instanceof RedisBus ? bus.describe : "in-process (single instance)"}\n`);
});

/**
 * The live feed, authenticated at the upgrade rather than after it.
 *
 * `noServer` so the session is verified before the handshake completes: an
 * unauthenticated caller gets a plain 401 and no socket is ever allocated for
 * them. Accepting the upgrade first and closing afterwards would work, but it
 * hands anyone an open socket for the duration of a token check.
 *
 * Browsers cannot set headers on a WebSocket, so proof travels in the query
 * string. The dashboard sends a short-lived ticket from `POST /api/ws-tickets`
 * rather than the session JWT, which would otherwise land in access logs.
 * `token=` remains accepted for non-browser callers.
 */
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  void (async () => {
    let userId: string | undefined;
    try {
      const runId = url.searchParams.get("runId");
      const ticket = tickets.resolve(url.searchParams.get("ticket") ?? undefined);
      if (ticket) {
        if (ticket.runId && runId && ticket.runId !== runId) throw new Error("ticket run mismatch");
        userId = scope(ticket.userId);
      } else {
        const user = await auth.authenticate(url.searchParams.get("token") ?? undefined);
        userId = scope(user.id);
      }
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const remove = hub.add({
        runId: url.searchParams.get("runId"),
        userId,
        send: (data) => ws.send(data),
      });
      ws.on("close", remove);
      ws.on("error", remove);
    });
  })();
});

/**
 * Last resort, not a licence to leak rejections.
 *
 * Every known source is caught at the point it is created (see `detach`), and
 * this exists for the ones nobody has found yet. Node's default is to abort on
 * an unhandled rejection, which for this process means killing every run in
 * flight and orphaning the sandboxes they are paying for by the second -
 * strictly worse than logging and carrying on. Anything logged here is a bug
 * to fix at its source.
 */
process.on("unhandledRejection", (reason) => {
  console.error(
    "[kapi] unhandled rejection (continuing):",
    reason instanceof Error ? (reason.stack ?? reason.message) : reason,
  );
});

const shutdown = async () => {
  await bus.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
