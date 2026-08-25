import { InProcessBus } from "./inprocess.ts";
import { RedisBus } from "./redis.ts";
import type { MessageBus } from "./types.ts";

export * from "./types.ts";
export * from "./conversation.ts";
export { InProcessBus, RedisBus };

export function createMessageBus(name = process.env.KAPI_BUS ?? "inprocess"): MessageBus {
  return name === "redis" ? new RedisBus() : new InProcessBus();
}
