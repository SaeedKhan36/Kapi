/**
 * ioredis is an optional peer: only RedisBus needs it, and only when the
 * orchestrator runs multi-instance. Declaring it here keeps the dependency
 * genuinely optional instead of forcing it on every install.
 */
declare module "ioredis" {
  export default class Redis {
    constructor(url: string);
    publish(channel: string, message: string): Promise<number>;
    subscribe(channel: string): Promise<void>;
    on(event: "message", cb: (channel: string, message: string) => void): this;
    quit(): Promise<unknown>;
  }
}
