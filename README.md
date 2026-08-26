# kapi

A free, open multi-agent AI engineering team. A **Master Agent** plans; **Worker
Agents** implement in parallel, each in its own isolated sandbox on its own git
branch, coordinating over a message bus.

Inspired by [capy.ai](https://capy.ai), built to run on free tiers.

```
                   ┌───────────────────────────────┐
   goal  ─────────▶│  ORCHESTRATOR                 │
                   │  DAG scheduler · bus · store  │
                   └───────────────┬───────────────┘
                                   │
              ┌────────────────────┴────────────────────┐
              ▼                                         ▼
   ┌────────────────────┐          ┌──────────────────────────────┐
   │ MASTER             │          │ WORKERS (one sandbox each)   │
   │ read-only repo     │          │ frontend · backend · db · …  │
   │ → task DAG         │          │ own branch · own commits     │
   │ → shared contract  │          │ talk to each other directly  │
   └────────────────────┘          └──────────────────────────────┘
```

## Quick start

```bash
pnpm install
cp .env.example .env          # add GEMINI_API_KEY
pnpm smoke                    # verify sandbox + db + llm
```

Then drive a run either way — both hit the same engine.

**Dashboard** — orchestrator on `:8787`, web UI on `:3000` (Vite proxies `/api`
and `/ws`, so the browser stays same-origin). `/` is the landing page; the
dashboard lives at `/app`, behind Clerk when Clerk is configured:

```bash
pnpm dev
```

**CLI**:

```bash
pnpm run:agent --repo=https://github.com/you/repo.git --goal="add a /health endpoint"
```

No database setup is needed to start: with `DATABASE_URL` unset, the store falls
back to embedded PGlite in `.kapi/db` and creates its tables on first run.

## What you need (all free)

| Key | Where | Required? |
|---|---|---|
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — no credit card | **yes** |
| `GITHUB_TOKEN` | fine-grained PAT, `contents:write` | only to push worker branches |
| `DAYTONA_API_KEY` | [daytona.io](https://daytona.io) — $200 trial credit | only for cloud sandboxes |
| `DATABASE_URL` | [neon.tech](https://neon.tech) | no — falls back to embedded PGlite |
| `CLERK_*`, `GITHUB_APP_*` | [clerk.com](https://clerk.com) — free to 10k MAU | only to run kapi for more than one person |

`GROQ_API_KEY` and `CEREBRAS_API_KEY` are optional failover for when Gemini's
daily quota runs out. Without `GITHUB_TOKEN` a run still completes — worker
branches just stay local to their sandbox. See `.env.example` for the full list,
including ports and the free-tier budget caps.

## How a run works

1. **Plan.** The master clones the repo into its own sandbox, reads it
   read-only, and emits a `TaskGraph`: a shared contract plus tasks with
   `dependsOn` edges, each assigned a role (`frontend`, `backend`, `database`,
   `testing`, `infra`, `docs`, `generalist`).
2. **Schedule.** The orchestrator walks the DAG, running every task whose
   dependencies are terminal, up to `maxConcurrency`.
3. **Implement.** Each worker gets a fresh sandbox, a clone on its own branch,
   and the coding engine loop. Tasks move `pending → ready → assigned → running
   → review | blocked | failed`.
4. **Report.** Commits land on the worker's branch and are pushed when a
   `GITHUB_TOKEN` is present; branches, changed files, and per-task summaries
   come back as artifacts. Opening PRs is not automated yet — merge the branches
   yourself.

Every message crossing the bus is persisted as it goes, so the CLI output, the
dashboard feed, and the audit log are the same data.

## Repo layout

```
apps/orchestrator   HTTP + WebSocket API, run engine, DAG scheduler, store
apps/web            TanStack Start app — landing page, then the dashboard
packages/*          the interfaces below
scripts/            run.ts (CLI) · smoke.ts · probe-models.ts · test-*.ts
```

## Design

Interfaces with more than one implementation, so no vendor is load-bearing:

| Package | Interface | Implementations |
|---|---|---|
| `packages/sandbox` | `SandboxProvider` | `local`, `docker`, `daytona` |
| `packages/llm` | `LLMProvider` | Gemini, Groq, Cerebras (auto-failover) |
| `packages/agent-engine` | `CodingEngine` | `direct` (built-in), `aider` |
| `packages/bus` | `MessageBus` | in-process, Redis |
| `packages/identity` | `RepoAccess` | PAT, GitHub App |
| `packages/db` | Drizzle schema | PGlite, Postgres/Neon |

> **PGlite is single-writer.** `DATABASE_URL` unset means an embedded database in
> `.kapi/db`, and two kapi processes cannot share it — running the orchestrator
> and a CLI run at once corrupts the directory. Use `DATABASE_URL=memory` for
> throwaway work, or point it at Neon when more than one process is involved.

The rest are plumbing: `packages/protocol` (zod wire types — messages, task
graph, shared contract), `packages/agent-runtime` (master planner and repo
context), `packages/env` (dependency-free `.env` loader that never clobbers real
deployment config).

### Who a run belongs to

kapi runs two ways, and the difference is entirely in `RepoAccess`.

**One operator.** Set `GITHUB_TOKEN` and nothing else. There is no login, no
database of users, and every run uses that one PAT. This is the quick start
above, and what the CLI does.

**Many people.** Set `CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` and a GitHub
App (`GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`) and the chain becomes:

```
Clerk session   → who is asking
Clerk GitHub    → their GitHub token, held and refreshed by Clerk,
  connection       used to list repos and check they could push themselves
GitHub App      → the repo owner installed kapi here
                  → a token for that one repository, contents-only, 1 hour
                     → the only credential a sandbox ever sees
```

Enable GitHub as a social connection in Clerk (with the `repo` scope) before
anyone tries to pick a repository; users add it from the account panel the
dashboard opens for them.

Both parties have to agree: the user must have push rights, *and* the owner
must have installed the app. Either alone is refused before a sandbox is
created, with a link to fix it. kapi stores no GitHub token at any point — the
user's grant lives in Clerk, and installation tokens are minted per operation.

`KAPI_AUTH_MODE` (`clerk` | `workos` | `none`) forces the choice; by default it
follows whichever provider is configured, preferring Clerk. The session
provider sits behind `SessionProvider` in `packages/identity`, so WorkOS
AuthKit remains a drop-in alternative.

### Credentials never persist in a sandbox

The coding engine runs model-chosen shell commands against repository contents,
so anything readable from inside a sandbox is readable by a prompt injection
carried in the repo being worked on. Tokens therefore never reach the
environment and never reach `.git/config`. `withGitAuth` writes one to a `0600`
file in a `0700` directory, points `GIT_ASKPASS` at it for the duration of a
single git command, and deletes it. `pnpm test:unit` asserts this against a real
sandbox — token absent from the filesystem, absent from the environment, auth
directory gone.

### The review loop

Nothing merges unless a Review Agent approves it. After a worker pushes, a
reviewer reads the branch's diff **from its own read-only sandbox** — it judges
what actually landed, not whatever state the worker's filesystem was left in.

Only `blocker` and `major` findings stop a merge; `minor` and `nit` ride along
on the pull request for a human to weigh. A reviewer that blocks on style
becomes a loop the worker cannot satisfy.

The stated decision is reconciled against the findings, because models regularly
say "approve" while listing a blocker. The findings are the evidence, so they
win. On a change request the worker gets a bounded number of revision attempts
(`--review-rounds`, default 1) with the blocking findings as its new
instruction; if it still fails, the branch stays pushed and unmerged for a
human, and the run reports the task as failed rather than quietly shipping it.

Each review costs exactly one LLM request. `--no-review` skips it.

### Dynamic redistribution

A failed task does not simply block everything downstream. The master examines
the failure — the worker's log, the reviewer's blocking findings, how many
attempts it has had — and picks one of three interventions:

- **retry** with concrete guidance, when the worker was capable but went wrong in
  a fixable way. Guidance is mandatory; a retry without it just repeats what
  already failed.
- **rescope** into 1–3 replacement tasks, when the *task* was the problem. Tasks
  waiting on the replaced one are rewired to wait on its replacements, or they
  would block forever on an id that will never run.
- **abandon**, and then decide whether dependants can proceed anyway. Work that
  was incidental to them should not sink them.

Because the plan changes mid-run, the scheduler holds a mutable task set rather
than a fixed list.

Every intervention is bounded: `--max-recoveries` per run (default 2, one LLM
request each) and `--max-attempts` per task (default 2). A decision that would
corrupt the graph — a replacement colliding with a live task, or one depending
on the task it replaces — is rejected and degraded to abandon rather than
spliced in.

### Two ideas worth knowing

**The shared contract prevents deadlock.** Workers run concurrently and cannot
see each other's code. If the frontend worker simply waited on the backend
worker, runs would hang. So the master decides every shared interface — routes,
payload shapes, table columns — *before* any worker starts, and ships it to all
of them. Workers build against the contract; `QUERY` is the exception, and every
query carries a timeout with a contract-based fallback.

**Agents dial out, the orchestrator routes.** Sandboxes are not addressable
inbound, so every agent opens an outbound connection. Worker→worker messages are
routed directly without the master relaying them, while the master keeps a
wildcard subscription so it still observes everything. Every message is
persisted — that one table is the bus, the audit log, and the UI feed.

## API

The orchestrator (`pnpm dev:api`, default `:8787`) is what the dashboard talks
to, and it is a plain HTTP + WebSocket surface you can drive yourself.

| Route | Does |
|---|---|
| `GET /api/health` | db target, sandbox provider, auth mode, whether an LLM key and a push credential are configured — **public** |
| `GET /api/me` | the caller, and whether their GitHub is connected |
| `GET /api/github/connect` | 302 into the provider's GitHub authorization flow, or `GITHUB_CONNECT_IN_APP` when the provider (Clerk) owns that flow client-side |
| `GET /api/github/repos` | repositories the caller can see |
| `GET /api/github/repos/:owner/:repo/branches` | its branches |
| `GET /api/github/repos/:owner/:repo/authorization` | whether a run here would be allowed, and how to fix it if not |
| `GET /api/runs` | the caller's runs |
| `GET /api/runs/:id` | one run with its tasks, agents, messages, artifacts |
| `POST /api/runs` | start a run — `{ goal, repoUrl, baseBranch?, maxConcurrency?, maxTasks?, providerName? }`; `429` when rate-limited or at the concurrent-run cap |
| `WS /ws?runId=…&token=…` | live `status` / `plan` / `task` / `message` events |

Everything but `/api/health` needs `Authorization: Bearer <session token>`
when authentication is on; in `none` mode there is one implicit
local user and the header is ignored. The websocket authenticates during the
HTTP upgrade — a bad token gets a plain `401`, not an opened-then-closed
socket — and takes its token in the query string because browsers cannot set
headers on a WebSocket.

`POST /api/runs` returns `202 { runId }` as soon as the run row exists rather
than holding the request open for the minutes a run takes; follow the rest over
the websocket. It answers `403` with `{ code, action, installUrl }` when the
repository has not been authorized, so a caller can send the user somewhere
useful. Connecting mid-run replays recent events, and omitting `runId`
subscribes to all of the caller's runs.

## CLI

```
pnpm run:agent --repo=<git-url> --goal="<what to build>"

  --provider=local|docker|daytona   sandbox backend (default: $SANDBOX_PROVIDER or local)
  --branch=main                     base branch
  --concurrency=4                   max parallel workers
  --max-tasks=6                     cap the plan size
  --dry-plan                        plan only, do not run workers
```

`--dry-plan` costs one or two LLM requests and prints the task graph and shared
contract — the cheapest way to see what the master intends before spending
quota on workers.

## Free-tier guardrails

Built in, not bolted on:

- **Per-run budgets.** Hard caps on requests and tokens; `BudgetExceededError`
  pauses the run instead of silently draining a daily quota.
- **Bounded agent context.** The coding loop keeps the task brief plus a sliding
  window of recent turns, summarising older steps. Appending every observation
  forever makes cost grow quadratically with steps — that alone burned 833k
  tokens in one early run.
- **Provider failover.** Gemini → Groq → Cerebras behind one interface.
- **Sandbox idle-TTL**, so a leaked Daytona sandbox cannot quietly burn credit.
- **A ceiling on live sandboxes** (`MAX_CONCURRENT_SANDBOXES`, default 12).
  `MAX_CONCURRENT_WORKERS` bounds one run, which is the wrong unit for money —
  ten runs of four workers is forty billable sandboxes and no single run has
  misbehaved. Enforced by wrapping the provider, so it covers the planner, the
  workers and the reviewers without four call sites having to remember.
- **Limits on what one caller may ask for** — `MAX_RUNS_PER_HOUR` as a token
  bucket, plus `MAX_CONCURRENT_RUNS` and `MAX_CONCURRENT_RUNS_PER_USER`. A
  refusal is a `429` carrying `Retry-After`. Without these, one caller can
  queue a hundred runs that starve everyone else and spend a daily LLM quota on
  planning before a sandbox is ever created.

Both ceilings are **per orchestrator process**, so a multi-instance deployment
should divide its budget between instances. `GET /api/health` reports the
configured limits and where the process currently sits against them.

> Keep `MAX_CONCURRENT_SANDBOXES` above `MAX_CONCURRENT_WORKERS`: a worker
> holds its own sandbox while the reviewer opens a second one to read the
> branch. A creation that cannot get a slot within `SANDBOX_SLOT_WAIT_MS`
> fails with a message naming the cap, rather than waiting forever.

### Measured, not assumed: Gemini's free tier has no Pro

Probing a real free-tier key (`pnpm tsx scripts/probe-models.ts`):

| Model | Free tier |
|---|---|
| `gemini-3.1-pro-preview`, `gemini-pro-latest`, any Pro | **429 — no free quota at all** |
| `gemini-3.5-flash` | works |
| `gemini-2.5-flash`, `gemini-3-flash-preview` | works |
| `gemini-3.1-flash-lite` | works (cheapest) |

So planning runs on Flash too, not Pro. Model availability also varies per key —
names in the public docs can 404 — so `GeminiProvider` carries an ordered
candidate list per tier and falls through on both 404 and 429. Run the probe
script against your own key before assuming a model exists.

**The cap is per model, not per project.** A real key reports
`GenerateRequestsPerDayPerProjectPerModel-FreeTier=20` — twenty requests per day
*for each model*. Pinning every call to the best model would spend a twentieth
of the day's capacity per request while its siblings sit idle, so the provider
round-robins across healthy models and drops exhausted ones to the back. That
turns ~20 requests/day into ~80. Budget accordingly: one run of this system costs
roughly 15–20 requests, so expect about four to six runs per day per key.

## Development

```bash
pnpm test:unit      # graph validation, bus routing, scheduler, model rotation — no API key needed
pnpm smoke          # end-to-end provider check (add --provider=local to force one)
pnpm typecheck
```

```bash
pnpm dev:api        # orchestrator only, watch mode
pnpm dev:web        # dashboard only (expects the API on :8787)
pnpm db:studio      # browse runs, tasks, and the message log
```

Requires Node 22+ and pnpm 10.

## Deploying

```bash
pnpm build          # dist/orchestrator.mjs + dist/migrate.mjs + the dashboard
pnpm db:migrate     # apply the schema
pnpm start          # node dist/orchestrator.mjs
```

Or as containers:

```bash
docker compose up --build
```

The orchestrator bundles to a single file that plain `node` runs — no pnpm, no
TypeScript, no `node_modules`. The dashboard's production server serves the
build and forwards `/api` and `/ws` to `ORCHESTRATOR_URL`, so the browser stays
same-origin exactly as it does behind Vite in development.

**A deployment needs a real `DATABASE_URL`.** PGlite ships WebAssembly that
cannot be bundled, so a built artifact has no embedded database — which is the
right constraint anyway, since PGlite allows one writer and could not be shared
by two instances.

**More than one orchestrator needs `KAPI_BUS=redis`.** Agents reach each other
over the bus, and the in-process one stops at the process boundary — two
instances on it produce workers that cannot hear their teammates. `REDIS_URL`
must be the TCP endpoint (`redis://` or `rediss://`), not a REST one: the bus
holds a subscription open. On Upstash that is the connection string on the
database page, and its password is **not** the REST token.

Asking for Redis and not getting it is a startup failure, not a fallback. A bus
that silently degrades to in-process delivery presents as a teammate that
stopped replying, which is far harder to diagnose than a container that refuses
to boot.

### Migrations

`packages/db/migrations` holds ordered SQL, generated with `pnpm db:generate`
and applied with `pnpm db:migrate`. `db:push` is still there for prototyping,
but it resolves drift by dropping whatever does not match, which is not
something to point at a database holding real runs.

| | |
|---|---|
| `pnpm db:migrate` | apply everything pending |
| `pnpm db:migrate --status` | what is applied, what is not |
| `pnpm db:migrate --baseline` | record migrations as applied **without running them** |

`--baseline` is for adopting a database that already matches the schema — one
built with `db:push` before migrations existed. Running the first migration
there would fail on its first `CREATE TABLE`; baselining writes the same
bookkeeping the migrator would have, so later migrations apply normally.

`pnpm test:unit` applies both the migrations and the embedded schema to a fresh
in-memory Postgres and compares them column by column, because they are written
by hand in two places and drift silently otherwise.

## Status

Early. It plans, runs workers in parallel, commits, and pushes branches. It does
not yet open pull requests, merge worker branches into the integration branch, or
resume an interrupted run.
