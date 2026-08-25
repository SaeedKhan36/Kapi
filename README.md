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
pnpm run:agent --repo=https://github.com/you/repo.git --goal="add a /health endpoint"
```

## What you need (all free)

| Key | Where | Required? |
|---|---|---|
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — no credit card | **yes** |
| `GITHUB_TOKEN` | fine-grained PAT, `contents:write` + `pull_requests:write` | only to push branches |
| `DAYTONA_API_KEY` | [daytona.io](https://daytona.io) — $200 trial credit | only for cloud sandboxes |
| `DATABASE_URL` | [neon.tech](https://neon.tech) | no — falls back to embedded PGlite |

`GROQ_API_KEY` and `CEREBRAS_API_KEY` are optional failover for when Gemini's
daily quota runs out.

## Design

Five interfaces, each with more than one implementation, so no vendor is load-bearing:

| Package | Interface | Implementations |
|---|---|---|
| `packages/sandbox` | `SandboxProvider` | `local`, `docker`, `daytona` |
| `packages/llm` | `LLMProvider` | Gemini, Groq, Cerebras (auto-failover) |
| `packages/agent-engine` | `CodingEngine` | `direct` (built-in), `aider` |
| `packages/bus` | `MessageBus` | in-process, Redis |
| `packages/db` | Drizzle schema | PGlite, Postgres/Neon |

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
candidate list per tier and falls through on both 404 and 429, remembering what
worked. Run the probe script against your own key before assuming a model exists.

## Development

```bash
pnpm test:unit      # graph validation, bus routing, scheduler — no API key needed
pnpm smoke          # end-to-end provider check
pnpm typecheck
```
