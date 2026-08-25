import { randomUUID } from "node:crypto";
import type { AgentId, AgentMessage, MessageType, OutboundMessage } from "@kapi/protocol";
import type { MessageBus, Unsubscribe } from "./types.ts";

export type SendOptions = Omit<OutboundMessage, "type" | "content" | "to"> & {
  timeoutMs?: number;
};

/**
 * An agent's handle on the bus: send, receive, and ask-with-timeout.
 *
 * `ask` is the deadlock guard in code form. A worker asking another worker for
 * information ALWAYS gets an answer or a timeout - never an indefinite wait.
 * The caller is expected to fall back to the shared contract on timeout.
 */
export class AgentChannel {
  #pending = new Map<string, { resolve: (m: AgentMessage) => void; timer: NodeJS.Timeout }>();
  #unsub: Unsubscribe;
  #handlers = new Set<(m: AgentMessage) => void>();

  constructor(
    private bus: MessageBus,
    readonly runId: string,
    readonly agentId: AgentId,
    private defaultTimeoutMs = 120_000,
  ) {
    this.#unsub = bus.subscribe(runId, agentId, (m) => this.#dispatch(m));
  }

  #dispatch(m: AgentMessage) {
    if (m.replyTo) {
      const waiter = this.#pending.get(m.replyTo);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.#pending.delete(m.replyTo);
        waiter.resolve(m);
        return;
      }
    }
    for (const h of this.#handlers) h(m);
  }

  onMessage(handler: (m: AgentMessage) => void): Unsubscribe {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  async send(to: AgentId, type: MessageType, content: string, extra: SendOptions = {}) {
    const { timeoutMs, ...rest } = extra;
    const message: AgentMessage = {
      id: randomUUID(),
      runId: this.runId,
      from: this.agentId,
      to,
      type,
      content,
      ts: new Date().toISOString(),
      ...rest,
    };
    await this.bus.publish(message);
    return message;
  }

  /**
   * Sends a request and waits for a correlated reply.
   * Resolves to null on timeout - callers must handle that, not assume success.
   */
  async ask(
    to: AgentId,
    type: MessageType,
    content: string,
    extra: SendOptions = {},
  ): Promise<AgentMessage | null> {
    const timeoutMs = extra.timeoutMs ?? this.defaultTimeoutMs;
    const { timeoutMs: _drop, ...rest } = extra;

    const message: AgentMessage = {
      id: randomUUID(),
      runId: this.runId,
      from: this.agentId,
      to,
      type,
      content,
      timeoutMs,
      ts: new Date().toISOString(),
      ...rest,
    };

    // Register the waiter BEFORE publishing. Delivery is synchronous, so a fast
    // responder can reply during publish() - if the waiter were registered
    // afterwards, that reply would find nothing pending and the promise would
    // never settle.
    const answer = new Promise<AgentMessage | null>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(message.id);
        resolve(null);
      }, timeoutMs);
      this.#pending.set(message.id, { resolve, timer });
    });

    await this.bus.publish(message);
    return answer;
  }

  /** Replies to a message, wiring up the correlation id automatically. */
  reply(to: AgentMessage, type: MessageType, content: string, extra: SendOptions = {}) {
    return this.send(to.from, type, content, { ...extra, replyTo: to.id, taskId: extra.taskId ?? to.taskId });
  }

  async close() {
    for (const { timer, resolve } of this.#pending.values()) {
      clearTimeout(timer);
      resolve(null as never);
    }
    this.#pending.clear();
    this.#handlers.clear();
    this.#unsub();
  }
}
