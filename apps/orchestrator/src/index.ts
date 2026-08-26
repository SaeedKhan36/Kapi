import { loadEnv } from "@kapi/env";
loadEnv();

import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { createDb, describeDbTarget } from "@kapi/db";
import { createMessageBus } from "@kapi/bus";
import {
  createRepoAccess, githubAppConfigured, listBranches, listRepositories,
  parseRepoUrl, IdentityError,
} from "@kapi/identity";
import { Store } from "./store.ts";
import { RunEngine, RunNotAuthorizedError } from "./run-engine.ts";
import { EventHub } from "./events.ts";
import { createAuth, type AuthedEnv } from "./auth.ts";
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
const bus = createMessageBus();
const hub = new EventHub();
const auth = createAuth(store);
const engine = new RunEngine(store, bus, { onEvent: (e) => hub.publish(e) });

/** In single-operator mode there is one user, so scoping reads is meaningless. */
const scope = (userId: string) => (auth.mode === "none" ? undefined : userId);

const app = new Hono<AuthedEnv>();
app.use("/api/*", cors());

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
  }),
);

app.use("/api/*", auth.middleware);

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

  const user = c.get("user");
  let repoAccess;
  try {
    repoAccess = await repoAccessFor(auth, user);
  } catch (err) {
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
        .catch((err) => {
          if (started) console.error(`[run] failed:`, err);
          else reject(err);
        });
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
  console.log(`  llm   ${process.env.GEMINI_API_KEY ? "configured" : "NOT configured - set GEMINI_API_KEY"}\n`);
});

/**
 * The live feed, authenticated at the upgrade rather than after it.
 *
 * `noServer` so the session is verified before the handshake completes: an
 * unauthenticated caller gets a plain 401 and no socket is ever allocated for
 * them. Accepting the upgrade first and closing afterwards would work, but it
 * hands anyone an open socket for the duration of a token check.
 *
 * The token travels in the query string because browsers cannot set headers on
 * a WebSocket. That puts it in this process's logs at most - it is the user's
 * own short-lived session token, and the alternative is a cookie, which the
 * dashboard does not use.
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
      const user = await auth.authenticate(url.searchParams.get("token") ?? undefined);
      userId = scope(user.id);
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

const shutdown = async () => {
  await bus.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
