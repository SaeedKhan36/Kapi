import type { AgentId, AgentMessage } from "@kapi/protocol";
import type { MessageBus, Unsubscribe } from "./types.ts";
import { InProcessBus } from "./inprocess.ts";

function redisUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const directUrl = env.REDIS_URL ?? env.UPSTASH_REDIS_URL;
  if (directUrl) return directUrl;

  const restUrl = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!restUrl || !token) return undefined;

  const host = new URL(restUrl).hostname;
  return `rediss://default:${encodeURIComponent(token)}@${host}:6379`;
}

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

  constructor(private url = redisUrlFromEnv()) {}

  async #connect() {
    if (this.#pub) return;
    if (!this.url) {
      throw new Error(
        "Redis is not configured. Set REDIS_URL or both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      );
    }
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
