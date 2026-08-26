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
and `/ws`, so the browser stays same-origin):

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
apps/web            TanStack Start dashboard — submit a run, watch it live
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
| `packages/db` | Drizzle schema | PGlite, Postgres/Neon |

The rest are plumbing: `packages/protocol` (zod wire types — messages, task
graph, shared contract), `packages/agent-runtime` (master planner and repo
context), `packages/env` (dependency-free `.env` loader that never clobbers real
deployment config).

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
| `GET /api/health` | db target, sandbox provider, whether an LLM key and `GITHUB_TOKEN` are configured |
| `GET /api/runs` | every run |
| `GET /api/runs/:id` | one run with its tasks, agents, messages, artifacts |
| `POST /api/runs` | start a run — `{ goal, repoUrl, baseBranch?, maxConcurrency?, maxTasks?, providerName? }` |
| `WS /ws?runId=…` | live `status` / `plan` / `task` / `message` events |

`POST /api/runs` returns `202 { runId }` as soon as the run row exists rather
than holding the request open for the minutes a run takes; follow the rest over
the websocket. Connecting mid-run replays recent events, and omitting `runId`
subscribes to everything.

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
pnpm db:push        # push the Drizzle schema — real Postgres only; PGlite self-creates
pnpm db:studio      # browse runs, tasks, and the message log
```

Requires Node 22+ and pnpm 10.

## Status

Early. It plans, runs workers in parallel, commits, and pushes branches. It does
not yet open pull requests, merge worker branches into the integration branch, or
resume an interrupted run.
