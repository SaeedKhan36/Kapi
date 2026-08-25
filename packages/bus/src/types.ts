import type { AgentMessage, AgentId } from "@kapi/protocol";

export type Unsubscribe = () => void;

/**
 * The Agent Communication Bus.
 *
 * Routing rules:
 *   - a message addressed to a specific AgentId reaches only that agent
 *   - "broadcast" reaches every agent on the run
 *   - the master additionally receives a copy of EVERY message, so it can
 *     supervise without workers having to relay through it
 */
export interface MessageBus {
  readonly name: string;
  publish(message: AgentMessage): Promise<void>;
  /** Subscribe to messages addressed to `agentId` (plus broadcasts). */
  subscribe(runId: string, agentId: AgentId, handler: (m: AgentMessage) => void): Unsubscribe;
  /** Subscribe to every message on a run, regardless of addressing. */
  subscribeAll(runId: string, handler: (m: AgentMessage) => void): Unsubscribe;
  close(): Promise<void>;
}
