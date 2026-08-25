import { EventEmitter } from "node:events";
import type { AgentId, AgentMessage } from "@kapi/protocol";
import type { MessageBus, Unsubscribe } from "./types.ts";

/**
 * Default bus: a single orchestrator process routing in memory.
 *
 * Deliberately the default rather than Redis - Upstash's free tier is 500k
 * commands/month, and a chatty multi-agent run would spend it on plumbing that
 * a single process handles for nothing. RedisBus exists for when the
 * orchestrator actually runs multi-instance.
 */
export class InProcessBus implements MessageBus {
  readonly name = "inprocess";
  #emitter = new EventEmitter();

  constructor() {
    // A busy run has many concurrent subscribers; the default cap of 10 is noise.
    this.#emitter.setMaxListeners(0);
  }

  async publish(message: AgentMessage) {
    this.#emitter.emit(`all:${message.runId}`, message);
    // A directed message goes ONLY to its addressee; `to: "broadcast"` resolves
    // to the broadcast channel here, which every agent also listens on.
    this.#emitter.emit(`to:${message.runId}:${message.to}`, message);
    // The master supervises everything without being on the critical path.
    if (message.to !== "master" && message.from !== "master") {
      this.#emitter.emit(`observe:${message.runId}:master`, message);
    }
  }

  subscribe(runId: string, agentId: AgentId, handler: (m: AgentMessage) => void): Unsubscribe {
    const direct = `to:${runId}:${agentId}`;
    const bcast = `to:${runId}:broadcast`;
    const seen = new Set<string>();
    const wrapped = (m: AgentMessage) => {
      if (m.from === agentId) return;      // never echo a sender its own message
      if (seen.has(m.id)) return;          // direct + broadcast can both fire
      seen.add(m.id);
      if (seen.size > 5000) seen.clear();
      handler(m);
    };

    this.#emitter.on(direct, wrapped);
    if (agentId !== "broadcast") this.#emitter.on(bcast, wrapped);
    if (agentId === "master") this.#emitter.on(`observe:${runId}:master`, wrapped);

    return () => {
      this.#emitter.off(direct, wrapped);
      this.#emitter.off(bcast, wrapped);
      this.#emitter.off(`observe:${runId}:master`, wrapped);
    };
  }

  subscribeAll(runId: string, handler: (m: AgentMessage) => void): Unsubscribe {
    const key = `all:${runId}`;
    this.#emitter.on(key, handler);
    return () => this.#emitter.off(key, handler);
  }

  async close() {
    this.#emitter.removeAllListeners();
  }
}
