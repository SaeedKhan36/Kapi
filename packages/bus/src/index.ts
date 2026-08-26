import { InProcessBus } from "./inprocess.ts";
import { RedisBus } from "./redis.ts";
import { wantsRedis } from "./redis-config.ts";
import type { MessageBus } from "./types.ts";

export * from "./types.ts";
export * from "./conversation.ts";
export * from "./redis-config.ts";
export { InProcessBus, RedisBus };

/**
 * Picks the bus, and refuses to guess.
 *
 * `KAPI_BUS=redis` with a broken configuration used to fall back to in-process
 * delivery, which is the worst possible answer: a multi-instance deployment
 * comes up looking healthy while agents on different instances cannot hear
 * each other. Asking for Redis and not getting it is a startup failure.
 */
export function createMessageBus(name = process.env.KAPI_BUS ?? "inprocess"): MessageBus {
  return name.trim().toLowerCase() === "redis" ? new RedisBus() : new InProcessBus();
}

/**
 * Connects the bus, when it has something to connect to.
 *
 * Separate from construction so the caller decides where a failure surfaces:
 * the orchestrator awaits this at boot, while the CLI and the tests do not
 * need it.
 */
export async function readyMessageBus(bus: MessageBus): Promise<void> {
  if (bus instanceof RedisBus) await bus.ready();
}

export { wantsRedis };
