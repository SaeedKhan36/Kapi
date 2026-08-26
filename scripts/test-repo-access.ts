/**
 * The credential seam: who may run against a repository, and with what token.
 *
 * Exercises `RepoAccess` directly and through the run engine, with a stub
 * standing in for GitHub. The point is that the engine asks rather than
 * assuming - swapping a PAT for a scoped GitHub App token must not require the
 * scheduler to know anything about either.
 */
import { createMessageBus } from "../packages/bus/src/index.ts";
import { createDb } from "../packages/db/src/index.ts";
import { PatRepoAccess, type AuthorizationResult, type RepoAccess } from "../packages/identity/src/index.ts";
import type { TaskGraph } from "../packages/protocol/src/index.ts";
import { LocalProvider } from "../packages/sandbox/src/index.ts";
import { RunEngine, RunNotAuthorizedError } from "../apps/orchestrator/src/run-engine.ts";
import { Store } from "../apps/orchestrator/src/store.ts";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "\x1b[32mok  \x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${extra ? `  | ${extra}` : ""}`);
  if (!cond) failures++;
};

const graph: TaskGraph = {
  goal: "test",
  contract: { summary: "none", endpoints: [], tables: [], conventions: [] },
  tasks: [{
    id: "only", title: "only", instruction: "do it", role: "generalist",
    dependsOn: [], touches: [], acceptance: [],
  }],
};

/** Records what the engine asked for, and answers however the test wants. */
class StubAccess implements RepoAccess {
  readonly name = "stub";
  tokenRequests: string[] = [];
  authorizeRequests: string[] = [];

  constructor(
    private decision: AuthorizationResult = { ok: true },
    private token: string | undefined = "stub-token",
  ) {}

  async tokenFor(repoUrl: string) { this.tokenRequests.push(repoUrl); return this.token; }
  async authorize(repoUrl: string) { this.authorizeRequests.push(repoUrl); return this.decision; }
  async identity() { return { name: "Stub Person", email: "stub@example.com" }; }
  async apiToken() { return "stub-api-token"; }
}

/** Skips real git: the credential seam is what is under test, not the clone. */
class StubProvider extends LocalProvider {
  override async exec(id: string, cmd: string, opts?: Parameters<LocalProvider["exec"]>[2]) {
    if (/^git /.test(cmd.trim())) {
      return { exitCode: 0, stdout: cmd.includes("rev-parse") ? "base000" : "", stderr: "", durationMs: 0 };
    }
    return super.exec(id, cmd, opts);
  }
}

const runWith = async (access: RepoAccess, repoUrl = "https://github.com/acme/widget.git") => {
  // Ephemeral database: sharing the development PGlite directory corrupts it.
  const db = await createDb("memory");
  const bus = createMessageBus();
  const engine = new RunEngine(new Store(db), bus, {
    repoAccess: access,
    planOverride: async () => graph,
    createProvider: () => new StubProvider(),
    // Plan only: the point is the authorization gate, not the worker loop.
  });
  try {
    return { ok: true as const, result: await engine.execute({ goal: "test goal", repoUrl, planOnly: true }) };
  } catch (err) {
    return { ok: false as const, err };
  } finally {
    await bus.close();
  }
};

const main = async () => {
  console.log("\n\x1b[1mrepo access\x1b[0m\n");

  // --- the PAT path stays exactly as permissive as it was -----------------
  const pat = new PatRepoAccess("ghp_example", { name: "kapi-agent", email: "agent@kapi.local" });
  check("PAT authorizes GitHub", (await pat.authorize("https://github.com/a/b.git")).ok);
  check("PAT authorizes any git host", (await pat.authorize("https://git.example.com/a/b.git")).ok,
    "a PAT is not GitHub-specific");
  check("PAT returns its token for any repo",
    await pat.tokenFor("https://github.com/a/b.git") === "ghp_example");

  const noToken = new PatRepoAccess(undefined);
  check("missing PAT is allowed, not an error", (await noToken.authorize("https://github.com/a/b.git")).ok,
    "runs without push still complete");
  check("missing PAT yields no token", await noToken.tokenFor("https://github.com/a/b.git") === undefined);

  // --- the engine asks before it spends -----------------------------------
  const allowed = new StubAccess();
  const ran = await runWith(allowed);
  check("run proceeds when authorized", ran.ok);
  check("engine authorized before running", allowed.authorizeRequests.length === 1,
    allowed.authorizeRequests.join(", "));
  check("engine authorized the requested repo",
    allowed.authorizeRequests[0] === "https://github.com/acme/widget.git");

  const refused = new StubAccess({
    ok: false,
    reason: "Install the Kapi GitHub App on acme/widget.",
    installUrl: "https://github.com/apps/kapi/installations/new",
    action: "install",
  });
  const blocked = await runWith(refused);
  check("run refused when not authorized", !blocked.ok);
  check("refusal is a RunNotAuthorizedError", !blocked.ok && blocked.err instanceof RunNotAuthorizedError,
    !blocked.ok ? String((blocked.err as Error).name) : "");
  check("refusal carries the install URL",
    !blocked.ok && (blocked.err as RunNotAuthorizedError).installUrl?.includes("apps/kapi") === true);
  check("refusal carries the action",
    !blocked.ok && (blocked.err as RunNotAuthorizedError).action === "install");
  check("nothing was minted for a refused run", refused.tokenRequests.length === 0,
    `${refused.tokenRequests.length} token request(s)`);

  console.log(failures === 0 ? "\n\x1b[32mALL PASS\x1b[0m\n" : `\n\x1b[31m${failures} FAILED\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
};

await main();
