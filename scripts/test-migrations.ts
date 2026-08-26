/**
 * The migration SQL and the embedded schema must describe the same database.
 *
 * There are two hand-written paths to a schema: `applyEmbeddedSchema` creates
 * tables for the embedded PGlite, and packages/db/migrations holds the SQL
 * real Postgres gets. Nothing forces them to agree, so a column added to one
 * and not the other produces a deployment that works locally and fails in
 * production - precisely the failure a migration system exists to prevent.
 *
 * Both are applied to a fresh in-memory Postgres and compared.
 */
import { applyEmbeddedSchema } from "../packages/db/src/index.ts";
import {
  applyMigrationsTo, columnShape, newEmbeddedClient,
} from "../packages/db/src/migrate.ts";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "\x1b[32mok  \x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${extra ? `  | ${extra}` : ""}`);
  if (!cond) failures++;
};

const main = async () => {
  console.log("\n\x1b[1mmigrations\x1b[0m\n");

  // --- a fresh database accepts the migrations, in order --------------------
  const migrated = await newEmbeddedClient();
  let tags: string[] = [];
  try {
    tags = await applyMigrationsTo(migrated);
    check("migrations apply to an empty database", true, `${tags.length} applied`);
  } catch (err) {
    check("migrations apply to an empty database", false, err instanceof Error ? err.message : String(err));
  }
  check("at least one migration exists", tags.length > 0, tags.join(", "));

  const migratedShape = await columnShape(migrated);
  const tables = new Set([...migratedShape.keys()].map((k) => k.split(".")[0]));

  for (const t of ["users", "runs", "tasks", "agents", "agent_messages", "artifacts", "github_installations"]) {
    check(`migration creates ${t}`, tables.has(t));
  }
  check("runs.user_id exists", migratedShape.has("runs.user_id"), "run ownership depends on it");

  // --- and the embedded path produces the same thing ------------------------
  const embedded = await newEmbeddedClient();
  await applyEmbeddedSchema(embedded);
  const embeddedShape = await columnShape(embedded);

  const onlyInMigration = [...migratedShape.keys()].filter((k) => !embeddedShape.has(k));
  const onlyInEmbedded = [...embeddedShape.keys()].filter((k) => !migratedShape.has(k));

  check("no column exists only in the migrations", onlyInMigration.length === 0,
    onlyInMigration.join(", ") || "none");
  check("no column exists only in the embedded schema", onlyInEmbedded.length === 0,
    onlyInEmbedded.join(", ") || "none");

  const mismatched = [...migratedShape.entries()]
    .filter(([k, v]) => embeddedShape.has(k) && embeddedShape.get(k) !== v)
    .map(([k, v]) => `${k}: migration=${v} embedded=${embeddedShape.get(k)}`);
  check("column types and nullability agree", mismatched.length === 0,
    mismatched.slice(0, 4).join("; ") || "identical");

  await migrated.close();
  await embedded.close();

  console.log(failures === 0 ? "\n\x1b[32mALL PASS\x1b[0m\n" : `\n\x1b[31m${failures} FAILED\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
};

await main();
