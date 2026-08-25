import { z } from "zod";
import { AgentIdSchema } from "./ids.ts";

/**
 * The wire protocol for the Agent Communication Bus.
 *
 * Workers talk to each other directly (routed by the orchestrator, NOT relayed
 * by the master). The master observes everything via a wildcard subscription.
 */
export const MessageTypeSchema = z.enum([
  // lifecycle
  "TASK_ASSIGNED",
  "TASK_STARTED",
  "TASK_COMPLETED",
  "TASK_FAILED",
  // coordination
  "NEEDS_HELP",
  "BLOCKED",
  "API_READY",
  "SCHEMA_READY",
  "TEST_FAILED",
  // review
  "CODE_REVIEW_REQUESTED",
  "CHANGE_REQUESTED",
  // runtime plumbing
  "PLAN_READY",
  "QUERY",
  "QUERY_RESPONSE",
  "LOG",
  "HEARTBEAT",
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

/** Message types that carry a request expecting a correlated reply. */
export const REQUEST_TYPES = ["QUERY", "NEEDS_HELP", "CODE_REVIEW_REQUESTED"] as const;

export const TaskStatusSchema = z.enum([
  "pending",
  "ready",
  "assigned",
  "running",
  "blocked",
  "review",
  "merged",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TERMINAL_STATUSES: readonly TaskStatus[] = ["merged", "failed", "cancelled"];
export const isTerminal = (s: TaskStatus): boolean => TERMINAL_STATUSES.includes(s);

export const FileRefSchema = z.object({
  path: z.string(),
  action: z.enum(["created", "modified", "deleted", "read"]).default("modified"),
  sha: z.string().optional(),
});
export type FileRef = z.infer<typeof FileRefSchema>;

export const AgentMessageSchema = z.object({
  id: z.string(),
  runId: z.string(),
  taskId: z.string().optional(),

  from: AgentIdSchema,
  to: AgentIdSchema,

  type: MessageTypeSchema,
  content: z.string(),

  files: z.array(FileRefSchema).optional(),
  dependsOn: z.array(z.string()).optional(),
  status: TaskStatusSchema.optional(),

  /** Set on a reply; carries the `id` of the message being answered. */
  replyTo: z.string().optional(),
  /** For requests: how long the sender will wait before giving up. */
  timeoutMs: z.number().int().positive().optional(),

  ts: z.string().datetime(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

/** Envelope for messages sent by an agent before the orchestrator stamps id/ts. */
export const OutboundMessageSchema = AgentMessageSchema.omit({
  id: true,
  ts: true,
  runId: true,
  from: true,
});
export type OutboundMessage = z.infer<typeof OutboundMessageSchema>;
