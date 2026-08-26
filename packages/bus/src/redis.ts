import { detach } from "@kapi/protocol";
import type { AgentId, AgentMessage } from "@kapi/protocol";
import type { MessageBus, Unsubscribe } from "./types.ts";
import { InProcessBus } from "./inprocess.ts";
import { redact, resolveRedisUrl } from "./redis-config.ts";

// Type-only, so importing it cannot pull ioredis into a build that never
// reaches the Redis path.
type RedisClient = import("ioredis").default;

/**
 * Redis-backed bus for when the orchestrator runs more than one instance.
 *
 * Fans out over a per-run pub/sub channel and mirrors into a local
 * InProcessBus, so subscription semantics stay identical to single-process
 * mode and a worker cannot tell which instance its teammate is on.
 *
 * The configuration is resolved when this is constructed rather than on first
 * use. A bus that fails late does not look like a failure: messages reach the
 * agents on one instance and silently miss the rest, which presents as a
 * teammate that stopped answering.
 */
export class RedisBus implements MessageBus {
  readonly name = "redis";
  #local = new InProcessBus();
  #sub: RedisClient | null = null;
  #pub: RedisClient | null = null;
  #channels = new Set<string>();
  #connecting: Promise<void> | undefined;
  readonly url: string;

  constructor(url?: string) {
    // Throws a RedisConfigError naming the problem, at construction.
    this.url = url ?? resolveRedisUrl();
  }

  /** How this connection should be described in a log line. */
  get describe() {
    return redact(this.url);
  }

  async #connect(): Promise<{ pub: RedisClient; sub: RedisClient }> {
    if (this.#pub && this.#sub) return { pub: this.#pub, sub: this.#sub };
    this.#connecting ??= (async () => {
      const { default: Redis } = await import("ioredis").catch((cause) => {
        throw new Error(
          "KAPI_BUS=redis needs the ioredis package, which is not installed. " +
          "Run `pnpm install`, or set KAPI_BUS=inprocess.",
          { cause },
        );
      });

      // A subscriber that gives up mid-run silently stops delivering, so let
      // it keep retrying; the orchestrator outlives transient outages.
      // lazyConnect defers the socket to ready(), where a failure is reported.
      const options = { maxRetriesPerRequest: null, lazyConnect: true };

      const pub = new Redis(this.url, options);
      const sub = new Redis(this.url, options);

      // ioredis emits 'error' on an EventEmitter. Without a listener Node
      // rethrows it as an uncaught exception, so a Redis blip would take the
      // orchestrator down - the exact failure mode `detach` exists to prevent.
      pub.on("error", (err: Error) => console.error(`[kapi] redis publisher error (retrying): ${err.message}`));
      sub.on("error", (err: Error) => console.error(`[kapi] redis subscriber error (retrying): ${err.message}`));

      sub.on("message", (_channel: string, payload: string) => {
        try {
          this.#local.publish(JSON.parse(payload) as AgentMessage);
        } catch {
          /* malformed payload from another instance - drop it */
        }
      });

      await Promise.all([pub.connect(), sub.connect()]);
      this.#pub = pub;
      this.#sub = sub;
    })().catch((err) => {
      // Let the next attempt try again rather than caching the rejection.
      this.#connecting = undefined;
      throw err;
    });

    await this.#connecting;
    // Set by the block above; the assertion is the price of #connecting being
    // a Promise<void> that two callers may await concurrently.
    return { pub: this.#pub!, sub: this.#sub! };
  }

  /**
   * Connects, so a broken bus is a boot failure rather than a silent one.
   *
   * Called by the orchestrator at startup: an unreachable Redis or a wrong
   * password should stop a deployment coming up, not surface as agents that
   * cannot hear each other once a run is already spending money.
   */
  async ready(): Promise<void> {
    await this.#connect();
  }

  async #ensureChannel(runId: string) {
    const { sub } = await this.#connect();
    const channel = `kapi:run:${runId}`;
    if (this.#channels.has(channel)) return;
    this.#channels.add(channel);
    await sub.subscribe(channel);
  }

  async publish(message: AgentMessage) {
    await this.#ensureChannel(message.runId);
    const { pub } = await this.#connect();
    await pub.publish(`kapi:run:${message.runId}`, JSON.stringify(message));
  }

  // Subscribing is synchronous by contract, so the Redis round trip cannot be
  // awaited here. It is detached and caught rather than voided: an unreachable
  // Redis would otherwise reject into nothing and abort the whole process.
  // Local delivery still works, so a run degrades to single-process rather
  // than dying - and `ready()` has already ruled out a misconfiguration.
  subscribe(runId: string, agentId: AgentId, handler: (m: AgentMessage) => void): Unsubscribe {
    detach(this.#ensureChannel(runId), `subscribing to run ${runId}`);
    return this.#local.subscribe(runId, agentId, handler);
  }

  subscribeAll(runId: string, handler: (m: AgentMessage) => void): Unsubscribe {
    detach(this.#ensureChannel(runId), `subscribing to run ${runId}`);
    return this.#local.subscribeAll(runId, handler);
  }

  async close() {
    await Promise.all([this.#pub?.quit(), this.#sub?.quit()]);
    await this.#local.close();
  }
}
