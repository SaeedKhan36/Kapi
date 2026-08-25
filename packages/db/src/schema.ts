import {
  pgTable, text, timestamp, integer, jsonb, index, primaryKey,
} from "drizzle-orm/pg-core";

/** One user request = one run = one integration branch = (eventually) one PR. */
export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  goal: text("goal").notNull(),
  repoUrl: text("repo_url").notNull(),
  baseBranch: text("base_branch").notNull().default("main"),
  integrationBranch: text("integration_branch").notNull(),
  status: text("status").notNull().default("planning"),
  sandboxProvider: text("sandbox_provider").notNull(),
  /** Validated TaskGraph once the master has planned. */
  plan: jsonb("plan"),
  contract: jsonb("contract"),
  error: text("error"),
  prUrl: text("pr_url"),
  llmRequests: integer("llm_requests").notNull().default(0),
  llmTokens: integer("llm_tokens").notNull().default(0),
  sandboxSeconds: integer("sandbox_seconds").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

/** A live agent process. One row per master/worker sandbox. */
export const agents = pgTable(
  "agents",
  {
    runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    /** AgentId, e.g. "master" or "worker:backend". Unique within a run. */
    agentId: text("agent_id").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull().default("starting"),
    sandboxId: text("sandbox_id"),
    branch: text("branch"),
    lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.runId, t.agentId] })],
);

export const tasks = pgTable(
  "tasks",
  {
    runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    taskId: text("task_id").notNull(),
    title: text("title").notNull(),
    instruction: text("instruction").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull().default("pending"),
    dependsOn: jsonb("depends_on").$type<string[]>().notNull().default([]),
    touches: jsonb("touches").$type<string[]>().notNull().default([]),
    acceptance: jsonb("acceptance").$type<string[]>().notNull().default([]),
    assignedTo: text("assigned_to"),
    branch: text("branch"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.runId, t.taskId] }), index("tasks_status_idx").on(t.runId, t.status)],
);

/**
 * The durable bus. This single table is simultaneously the message log,
 * the audit trail, and the feed the UI streams.
 */
export const agentMessages = pgTable(
  "agent_messages",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    taskId: text("task_id"),
    from: text("from_agent").notNull(),
    to: text("to_agent").notNull(),
    type: text("type").notNull(),
    content: text("content").notNull(),
    files: jsonb("files"),
    dependsOn: jsonb("depends_on"),
    status: text("status"),
    replyTo: text("reply_to"),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("msg_run_ts_idx").on(t.runId, t.ts),
    index("msg_reply_idx").on(t.replyTo),
  ],
);

/** Durable outputs: diffs, test reports, the shared contract, PR links. */
export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    taskId: text("task_id"),
    kind: text("kind").notNull(),
    body: jsonb("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("artifact_run_idx").on(t.runId, t.kind)],
);
