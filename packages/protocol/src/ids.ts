import { z } from "zod";

/**
 * Agent addressing. Every participant on the bus has a stable address:
 *   "orchestrator"        - the control plane itself
 *   "master"              - the planning/supervising agent
 *   "worker:<slug>"       - one worker, slug derived from its role (e.g. "worker:backend")
 *   "broadcast"           - fan-out to everyone on the run
 */
export const AgentIdSchema = z
  .string()
  .regex(
    /^(orchestrator|master|broadcast|worker:[a-z0-9][a-z0-9-]{0,38})$/,
    "must be orchestrator | master | broadcast | worker:<slug>",
  );
export type AgentId = z.infer<typeof AgentIdSchema>;

export const workerId = (slug: string): AgentId => `worker:${slug}`;
export const isWorker = (id: AgentId): boolean => id.startsWith("worker:");
export const workerSlug = (id: AgentId): string => id.replace(/^worker:/, "");

/** Roles a worker can be specialised into. Drives sandbox image + prompt framing. */
export const AgentRoleSchema = z.enum([
  "frontend",
  "backend",
  "database",
  "testing",
  "infra",
  "docs",
  "generalist",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;
