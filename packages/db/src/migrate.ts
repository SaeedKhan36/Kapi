import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Migrations for real Postgres.
 *
 * `db:push` - what kapi used before this existed - diffs the schema against
 * whatever the live database currently looks like and applies the difference.
 * That is fine while nothing is deployed and dangerous the moment something
 * is, because drift is resolved by dropping what does not match. Ordered,
 * reviewable files are the alternative.
 *
 * Lives in this package rather than in scripts/ because `postgres` and
 * `drizzle-orm` are its dependencies, and pnpm's isolated layout means nothing
 * outside can resolve them.
 */
const MIGRATIONS = resolve("packages/db/migrations");
const SCHEMA = "drizzle";
const TABLE = "__drizzle_migrations";

export type MigrationState = { tag: string; hash: string; when: number; applied: boolean };

/** Minimal surface a schema can be applied to and inspected through. */
export type SqlClient = {
  exec: (sql: string) => Promise<unknown>;
  query: <T>(sql: string) => Promise<{ rows: T[] }>;
  close: () => Promise<void>;
};

/**
 * A throwaway in-memory Postgres.
 *
 * Exposed because PGlite is this package's dependency and pnpm's isolated
 * layout puts it out of reach of anything else in the workspace.
 */
export async function newEmbeddedClient(): Promise<SqlClient> {
  const { PGlite } = await import("@electric-sql/pglite");
  return new PGlite() as unknown as SqlClient;
}

/** Replays every migration, in journal order, onto a client. */
export async function applyMigrationsTo(client: SqlClient): Promise<string[]> {
  const tags = journal().map((e) => e.tag);
  for (const tag of tags) {
    const sql = readFileSync(`${MIGRATIONS}/${tag}.sql`, "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.exec(statement);
    }
  }
  return tags;
}

/** table.column -> "type/nullability", for comparing two schema definitions. */
export async function columnShape(client: SqlClient): Promise<Map<string, string>> {
  const res = await client.query<{
    table_name: string; column_name: string; data_type: string; is_nullable: string;
  }>(`
    select table_name, column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = 'public'
    order by table_name, column_name
  `);
  const out = new Map<string, string>();
  for (const c of res.rows) out.set(`${c.table_name}.${c.column_name}`, `${c.data_type}/${c.is_nullable}`);
  return out;
}

type JournalEntry = { idx: number; when: number; tag: string };

function journal(): JournalEntry[] {
  const parsed = JSON.parse(
    readFileSync(`${MIGRATIONS}/meta/_journal.json`, "utf8"),
  ) as { entries: JournalEntry[] };
  return parsed.entries.sort((a, b) => a.idx - b.idx);
}

/** Must match drizzle's own hashing, or applied migrations would run twice. */
const hashOf = (tag: string) =>
  createHash("sha256").update(readFileSync(`${MIGRATIONS}/${tag}.sql`, "utf8")).digest("hex");

async function connect(url: string) {
  const postgresMod = await import("postgres");
  return postgresMod.default(url, { max: 1, prepare: false });
}

type Sql = Awaited<ReturnType<typeof connect>>;

async function ensureBookkeeping(sql: Sql) {
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS "${SCHEMA}"."${TABLE}" ` +
      `(id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
  );
}

async function appliedHashes(sql: Sql): Promise<Set<string>> {
  const rows = await sql<{ hash: string }[]>`
    select hash from ${sql(SCHEMA)}.${sql(TABLE)}
  `.catch(() => [] as { hash: string }[]);
  return new Set(rows.map((r) => r.hash));
}

/** What is applied and what is pending, without changing anything. */
export async function migrationStatus(url: string): Promise<MigrationState[]> {
  const sql = await connect(url);
  try {
    const done = await appliedHashes(sql);
    return journal().map((e) => {
      const hash = hashOf(e.tag);
      return { tag: e.tag, hash, when: e.when, applied: done.has(hash) };
    });
  } finally {
    await sql.end();
  }
}

/** Applies every migration not yet applied. */
export async function runMigrations(url: string): Promise<MigrationState[]> {
  const sql = await connect(url);
  try {
    const done = await appliedHashes(sql);
    const pending = journal()
      .map((e) => ({ tag: e.tag, hash: hashOf(e.tag), when: e.when, applied: done.has(hashOf(e.tag)) }))
      .filter((m) => !m.applied);
    if (pending.length === 0) return [];

    const [{ drizzle }, { migrate }] = await Promise.all([
      import("drizzle-orm/postgres-js"),
      import("drizzle-orm/postgres-js/migrator"),
    ]);
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS });
    return pending;
  } finally {
    await sql.end();
  }
}

/**
 * Records migrations as applied without running them.
 *
 * The first migration describes tables an already-running deployment has, so
 * executing it there fails on the first CREATE TABLE. Writing the same
 * bookkeeping the migrator would have written lets later migrations apply
 * normally. Only correct when the database already matches the schema.
 */
export async function baselineMigrations(url: string): Promise<MigrationState[]> {
  const sql = await connect(url);
  try {
    await ensureBookkeeping(sql);
    const done = await appliedHashes(sql);
    const pending = journal()
      .map((e) => ({ tag: e.tag, hash: hashOf(e.tag), when: e.when, applied: done.has(hashOf(e.tag)) }))
      .filter((m) => !m.applied);

    for (const m of pending) {
      await sql`
        insert into ${sql(SCHEMA)}.${sql(TABLE)} ("hash", "created_at")
        values (${m.hash}, ${m.when})
      `;
    }
    return pending;
  } finally {
    await sql.end();
  }
}
