import type { AgentId, AgentMessage } from "@kapi/protocol";
import type { MessageBus, Unsubscribe } from "./types.ts";
import { InProcessBus } from "./inprocess.ts";

/**
 * Redis-backed bus for when the orchestrator runs more than one instance.
 *
 * Fans out over a per-run pub/sub channel and mirrors into a local InProcessBus
 * so subscription semantics stay identical to single-process mode.
 */
export class RedisBus implements MessageBus {
  readonly name = "redis";
  #local = new InProcessBus();
  #sub: any = null;
  #pub: any = null;
  #channels = new Set<string>();

  constructor(private url = process.env.REDIS_URL ?? process.env.UPSTASH_REDIS_URL) {}

  async #connect() {
    if (this.#pub) return;
    if (!this.url) throw new Error("REDIS_URL is not set");
    const { default: Redis } = await import("ioredis");
    this.#pub = new Redis(this.url);
    this.#sub = new Redis(this.url);
    this.#sub.on("message", (_channel: string, payload: string) => {
      try {
        this.#local.publish(JSON.parse(payload) as AgentMessage);
      } catch {
        /* malformed payload from another instance - drop it */
      }
    });
  }

  async #ensureChannel(runId: string) {
    await this.#connect();
    const channel = `kapi:run:${runId}`;
    if (this.#channels.has(channel)) return;
    this.#channels.add(channel);
    await this.#sub.subscribe(channel);
  }

  async publish(message: AgentMessage) {
    await this.#ensureChannel(message.runId);
    await this.#pub.publish(`kapi:run:${message.runId}`, JSON.stringify(message));
  }

  subscribe(runId: string, agentId: AgentId, handler: (m: AgentMessage) => void): Unsubscribe {
    void this.#ensureChannel(runId);
    return this.#local.subscribe(runId, agentId, handler);
  }

  subscribeAll(runId: string, handler: (m: AgentMessage) => void): Unsubscribe {
    void this.#ensureChannel(runId);
    return this.#local.subscribeAll(runId, handler);
  }

  async close() {
    await Promise.all([this.#pub?.quit(), this.#sub?.quit()]);
    await this.#local.close();
  }
}
