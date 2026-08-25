import { randomUUID } from "node:crypto";
import { eq, and, asc } from "drizzle-orm";
import type { Db } from "@kapi/db";
import { schema } from "@kapi/db";
import type { AgentMessage, TaskGraph, TaskStatus } from "@kapi/protocol";

const { runs, tasks, agents, agentMessages, artifacts } = schema;

/** Thin persistence layer so the run engine never writes SQL inline. */
export class Store {
  constructor(private db: Db) {}

  async createRun(input: {
    id: string; goal: string; repoUrl: string; baseBranch: string;
    integrationBranch: string; sandboxProvider: string;
  }) {
    await this.db.insert(runs).values(input);
  }

  async updateRun(id: string, patch: Partial<typeof runs.$inferInsert>) {
    await this.db.update(runs).set(patch).where(eq(runs.id, id));
  }

  async getRun(id: string) {
    const [row] = await this.db.select().from(runs).where(eq(runs.id, id));
    return row ?? null;
  }

  async listRuns() {
    return this.db.select().from(runs).orderBy(asc(runs.createdAt));
  }

  async savePlan(runId: string, graph: TaskGraph) {
    await this.db.update(runs)
      .set({ plan: graph, contract: graph.contract, status: "running" })
      .where(eq(runs.id, runId));

    if (graph.tasks.length === 0) return;
    await this.db.insert(tasks).values(
      graph.tasks.map((t) => ({
        runId, taskId: t.id, title: t.title, instruction: t.instruction,
        role: t.role, dependsOn: t.dependsOn, touches: t.touches,
        acceptance: t.acceptance, status: "pending" as const,
      })),
    );
  }

  async setTaskStatus(runId: string, taskId: string, status: TaskStatus, patch: Partial<typeof tasks.$inferInsert> = {}) {
    await this.db.update(tasks)
      .set({ status, ...patch })
      .where(and(eq(tasks.runId, runId), eq(tasks.taskId, taskId)));
  }

  async listTasks(runId: string) {
    return this.db.select().from(tasks).where(eq(tasks.runId, runId));
  }

  async upsertAgent(input: {
    runId: string; agentId: string; role: string; status: string;
    sandboxId?: string | null; branch?: string | null;
  }) {
    await this.db.insert(agents).values(input)
      .onConflictDoUpdate({
        target: [agents.runId, agents.agentId],
        set: { status: input.status, sandboxId: input.sandboxId, branch: input.branch },
      });
  }

  async stopAgent(runId: string, agentId: string, status = "stopped") {
    await this.db.update(agents)
      .set({ status, stoppedAt: new Date() })
      .where(and(eq(agents.runId, runId), eq(agents.agentId, agentId)));
  }

  async listAgents(runId: string) {
    return this.db.select().from(agents).where(eq(agents.runId, runId));
  }

  /** Persists a bus message. This table is the durable log AND the UI feed. */
  async recordMessage(m: AgentMessage) {
    await this.db.insert(agentMessages).values({
      id: m.id, runId: m.runId, taskId: m.taskId ?? null,
      from: m.from, to: m.to, type: m.type, content: m.content,
      files: m.files ?? null, dependsOn: m.dependsOn ?? null,
      status: m.status ?? null, replyTo: m.replyTo ?? null,
      ts: new Date(m.ts),
    }).onConflictDoNothing();
  }

  async listMessages(runId: string) {
    return this.db.select().from(agentMessages)
      .where(eq(agentMessages.runId, runId))
      .orderBy(asc(agentMessages.ts));
  }

  async saveArtifact(runId: string, kind: string, body: unknown, taskId?: string) {
    await this.db.insert(artifacts).values({
      id: randomUUID(), runId, taskId: taskId ?? null, kind, body: body as never,
    });
  }

  async listArtifacts(runId: string) {
    return this.db.select().from(artifacts).where(eq(artifacts.runId, runId));
  }
}
