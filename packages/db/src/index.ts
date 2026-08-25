import { mkdirSync } from "node:fs";
import * as schema from "./schema.ts";

export * as schema from "./schema.ts";
export { schema as tables };

export type Db = Awaited<ReturnType<typeof createDb>>;

/**
 * Postgres, two ways, one schema:
 *   DATABASE_URL set   -> real Postgres (Neon in production)
 *   DATABASE_URL unset -> embedded PGlite in .kapi/db
 *
 * PGlite is genuine Postgres compiled to WASM, so day-one development needs no
 * account, no container, and no network - and the schema is identical when we
 * later point DATABASE_URL at Neon.
 */
export async function createDb(url = process.env.DATABASE_URL) {
  if (url) {
    const [{ drizzle }, postgresMod] = await Promise.all([
      import("drizzle-orm/postgres-js"),
      import("postgres"),
    ]);
    const client = postgresMod.default(url, { max: 4, prepare: false });
    return drizzle(client, { schema });
  }

  const [{ drizzle }, { PGlite }] = await Promise.all([
    import("drizzle-orm/pglite"),
    import("@electric-sql/pglite"),
  ]);
  mkdirSync(".kapi", { recursive: true });
  const client = new PGlite(".kapi/db");
  const db = drizzle(client, { schema });
  await ensureSchema(client);
  return db;
}

export function describeDbTarget(url = process.env.DATABASE_URL): string {
  if (!url) return "pglite (embedded, .kapi/db)";
  try {
    const u = new URL(url);
    return `postgres ${u.hostname}${u.pathname}`;
  } catch {
    return "postgres (unparsable DATABASE_URL)";
  }
}

/**
 * PGlite has no migration runner attached, so we create tables idempotently.
 * Kept in lockstep with schema.ts; drizzle-kit owns migrations for real Postgres.
 */
async function ensureSchema(client: { exec: (sql: string) => Promise<unknown> }) {
  await client.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
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
