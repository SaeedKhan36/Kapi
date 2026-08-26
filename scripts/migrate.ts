/**
 * Applies database migrations, or adopts a database that already matches.
 *
 *   pnpm db:migrate              apply everything not yet applied
 *   pnpm db:migrate --status     show what is applied and what is pending
 *   pnpm db:migrate --baseline   record migrations as applied without running
 *
 * The work lives in @kapi/db; this is the terminal in front of it.
 */
import { loadEnv } from "../packages/env/src/index.ts";
loadEnv();

import {
  baselineMigrations, migrationStatus, runMigrations,
} from "../packages/db/src/migrate.ts";

const flag = (name: string) => process.argv.includes(`--${name}`);

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

/** Never print the password, even into a terminal the operator is watching. */
const safeUrl = (url: string) => url.replace(/:\/\/([^:@/]+):[^@]*@/, "://$1:***@");

const main = async () => {
  const url = process.env.DATABASE_URL;

  // PGlite creates its tables on first open, so there is nothing to migrate.
  if (!url || url === "memory" || url === ":memory:") {
    console.log(
      "\nDATABASE_URL is not a Postgres connection string, so there is nothing to\n" +
      "migrate: the embedded database creates its schema when it is opened.\n",
    );
    return;
  }

  console.log(`\n${C.bold("kapi migrations")}  ${C.dim(safeUrl(url))}\n`);

  if (flag("status")) {
    const state = await migrationStatus(url);
    for (const m of state) {
      console.log(`  ${m.applied ? C.green("applied") : C.yellow("pending")}  ${m.tag}`);
    }
    const pending = state.filter((m) => !m.applied).length;
    console.log(`\n  ${state.length - pending} applied, ${pending} pending\n`);
    return;
  }

  if (flag("baseline")) {
    console.log(C.dim("  Recording migrations as applied WITHOUT running them.\n") +
                C.dim("  Only correct when the database already matches the schema.\n"));
    const recorded = await baselineMigrations(url);
    if (recorded.length === 0) {
      console.log("  nothing to baseline - every migration is already recorded\n");
      return;
    }
    for (const m of recorded) console.log(`  ${C.green("recorded")}  ${m.tag}`);
    console.log(`\n  ${C.green("done")} - later migrations will apply normally\n`);
    return;
  }

  const applied = await runMigrations(url);
  if (applied.length === 0) {
    console.log(`  ${C.green("up to date")}\n`);
    return;
  }
  for (const m of applied) console.log(`  ${C.green("applied")}  ${m.tag}`);
  console.log(`\n  ${C.green("done")}\n`);
};

try {
  await main();
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`\n${C.red("migration failed")}: ${detail}\n`);
  if (/already exists/i.test(detail)) {
    console.error(
      "The database already has these tables. If it already matches the schema,\n" +
      "adopt it rather than recreating it:\n\n  pnpm db:migrate --baseline\n",
    );
  }
  process.exit(1);
}
