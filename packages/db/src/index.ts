import { mkdirSync } from "node:fs";
import * as schema from "./schema.ts";

export * as schema from "./schema.ts";
export { schema as tables };

export type Db = Awaited<ReturnType<typeof createDb>>;

/**
 * Postgres, three ways, one schema:
 *   DATABASE_URL=postgres://...  -> real Postgres (Neon in production)
 *   DATABASE_URL=memory          -> ephemeral in-process PGlite
 *   DATABASE_URL unset           -> embedded PGlite in .kapi/db
 *
 * PGlite holds a single-writer data directory, so tests must never share the
 * development one: concurrent access corrupts it and the next open aborts
 * inside the WASM runtime.
 *
 * PGlite is genuine Postgres compiled to WASM, so day-one development needs no
 * account, no container, and no network - and the schema is identical when we
 * later point DATABASE_URL at Neon.
 *
 * postgres.js uses `prepare: false` so the Neon pooler (PgBouncer transaction
 * mode) can be used as DATABASE_URL without a separate direct connection.
 */
export async function createDb(url = process.env.DATABASE_URL) {
  const inMemory = url === "memory" || url === ":memory:";

  if (url && !inMemory) {
    const [{ drizzle }, postgresMod] = await Promise.all([
      import("drizzle-orm/postgres-js"),
      import("postgres"),
    ]);
    const client = postgresMod.default(url, {
      max: 4,
      prepare: false,
      onnotice: () => {},
    });
    const db = drizzle(client, { schema });
    try {
      await ensureSchema({
        exec: (sql) => client.unsafe(sql),
      });
    } catch (cause) {
      throw new Error(
        `could not initialise Postgres at ${describeDbTarget(url)}: ${String(cause)}`,
        { cause },
      );
    }
    return db;
  }

  const [{ drizzle }, { PGlite }] = await Promise.all([
    import("drizzle-orm/pglite"),
    import("@electric-sql/pglite"),
  ]);
  let client: InstanceType<typeof PGlite>;
  if (inMemory) {
    client = new PGlite();
  } else {
    mkdirSync(".kapi", { recursive: true });
    client = new PGlite(".kapi/db");
  }
  const db = drizzle(client, { schema });
  try {
    await ensureSchema(client);
  } catch (cause) {
    throw new Error(
      inMemory
        ? `could not initialise in-memory database: ${String(cause)}`
        : `could not open .kapi/db. PGlite allows a single writer, so this usually ` +
          `means another kapi process (an orchestrator or a run) already has it open. ` +
          `Stop the other process, or set DATABASE_URL to a real Postgres. ` +
          `If the directory is corrupted, delete .kapi/db and retry. (${String(cause)})`,
      { cause },
    );
  }
  return db;
}

export function describeDbTarget(url = process.env.DATABASE_URL): string {
  if (url === "memory" || url === ":memory:") return "pglite (in-memory)";
  if (!url) return "pglite (embedded, .kapi/db)";
  try {
    const u = new URL(url);
    return `postgres ${u.hostname}${u.pathname}`;
  } catch {
    return "postgres (unparsable DATABASE_URL)";
  }
}

/**
 * Create tables idempotently. PGlite has no migration runner; Neon/Postgres
 * gets the same SQL so pointing DATABASE_URL at a fresh database is enough.
 * Kept in lockstep with schema.ts.
 */
async function ensureSchema(client: { exec: (sql: string) => Promise<unknown> }) {
  await client.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT,
      name TEXT,
      github_login TEXT,
      organization_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS github_installations (
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      installation_id INTEGER NOT NULL,
      permissions JSONB,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (owner, repo)
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      goal TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      base_branch TEXT NOT NULL DEFAULT 'main',
      integration_branch TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planning',
      sandbox_provider TEXT NOT NULL,
      plan JSONB,
      contract JSONB,
      error TEXT,
      pr_url TEXT,
      llm_requests INTEGER NOT NULL DEFAULT 0,
      llm_tokens INTEGER NOT NULL DEFAULT 0,
      sandbox_seconds INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ
    );
    -- Runs predate authentication, so an existing .kapi/db needs the column
    -- added rather than created. CREATE TABLE IF NOT EXISTS would skip it.
    ALTER TABLE runs ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS runs_user_idx ON runs (user_id, created_at);
    CREATE TABLE IF NOT EXISTS agents (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'starting',
      sandbox_id TEXT,
      branch TEXT,
      last_heartbeat TIMESTAMPTZ,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      stopped_at TIMESTAMPTZ,
      PRIMARY KEY (run_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      instruction TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      depends_on JSONB NOT NULL DEFAULT '[]'::jsonb,
      touches JSONB NOT NULL DEFAULT '[]'::jsonb,
      acceptance JSONB NOT NULL DEFAULT '[]'::jsonb,
      assigned_to TEXT,
      branch TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      PRIMARY KEY (run_id, task_id)
    );
    CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks (run_id, status);
    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      task_id TEXT,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      files JSONB,
      depends_on JSONB,
      status TEXT,
      reply_to TEXT,
      ts TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS msg_run_ts_idx ON agent_messages (run_id, ts);
    CREATE INDEX IF NOT EXISTS msg_reply_idx ON agent_messages (reply_to);
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      task_id TEXT,
      kind TEXT NOT NULL,
      body JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS artifact_run_idx ON artifacts (run_id, kind);
  `);
}
