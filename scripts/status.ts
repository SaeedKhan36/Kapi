/** Prints what has actually been recorded: runs, tasks, and their outcomes. */
import { loadEnv } from "../packages/env/src/index.ts";
loadEnv();
import { createDb } from "../packages/db/src/index.ts";
import { runs, tasks } from "../packages/db/src/schema.ts";

const db = await createDb();
const allRuns = await db.select().from(runs);
const allTasks = await db.select().from(tasks);

const real = allRuns.filter((r) => !r.repoUrl.includes("example.invalid"));
console.log(`  ${allRuns.length} runs recorded (${real.length} against real repos), ${allTasks.length} tasks\n`);

for (const r of real) {
  console.log(`  ${r.id}  ${String(r.status).padEnd(24)} ${r.llmRequests} req / ${r.llmTokens.toLocaleString()} tok`);
  for (const t of allTasks.filter((t) => t.runId === r.id)) {
    console.log(`      ${String(t.status).padEnd(9)} ${t.taskId}`);
  }
}
process.exit(0);
