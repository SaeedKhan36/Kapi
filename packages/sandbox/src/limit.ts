import type { Sandbox, SandboxProvider, SandboxSpec } from "./types.ts";
import { SandboxError } from "./types.ts";

/**
 * A ceiling on how many sandboxes exist at once, across every run.
 *
 * `maxConcurrency` bounds one run's workers, which is the wrong unit for
 * money: ten runs of four workers is forty billable sandboxes and no
 * individual run has done anything wrong. Daytona bills per second against a
 * finite trial credit, so the cap that matters is the one over the whole
 * process.
 *
 * Enforced by decorating the provider rather than by checking in the
 * scheduler, because sandboxes are created in four places - the planner, the
 * repo preparation step, each worker, and each reviewer - and a rule that has
 * to be remembered at four call sites is a rule that will be missed at a
 * fifth.
 */
export class SandboxLimitError extends SandboxError {
  constructor(message: string, provider: string) {
    super(message, provider);
    this.name = "SandboxLimitError";
  }
}

export type SandboxLimiterOptions = {
  /** Live sandboxes allowed at once. */
  max: number;
  /**
   * How long a creation may wait for a slot before failing.
   *
   * Bounded on purpose. A worker holds its own sandbox while the reviewer
   * creates a second one, so acquisition nests, and an unbounded wait would
   * turn a full pool into a permanent hang instead of an error anyone can
   * read. A timeout makes the failure legible and recoverable.
   */
  waitMs?: number;
};

type Waiter = { resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> };

export class SandboxLimiter {
  readonly max: number;
  readonly waitMs: number;
  #active = 0;
  #queue: Waiter[] = [];

  constructor({ max, waitMs = 120_000 }: SandboxLimiterOptions) {
    this.max = Math.max(1, Math.floor(max));
    this.waitMs = waitMs;
  }

  get active() { return this.#active; }
  get waiting() { return this.#queue.length; }

  /** Takes a slot, waiting if the pool is full. Returns the release. */
  async acquire(what: string, provider = "sandbox"): Promise<() => void> {
    if (this.#active < this.max) {
      this.#active++;
      return this.#releaseOnce();
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#queue = this.#queue.filter((w) => w.timer !== timer);
        reject(new SandboxLimitError(
          `waited ${Math.round(this.waitMs / 1000)}s for a sandbox slot creating ${what}: ` +
          `${this.#active} of ${this.max} are in use. Raise MAX_CONCURRENT_SANDBOXES, ` +
          `or lower MAX_CONCURRENT_WORKERS so fewer runs compete for it.`,
          provider,
        ));
      }, this.waitMs);

      this.#queue.push({ resolve, reject, timer });
    });

    this.#active++;
    return this.#releaseOnce();
  }

  /**
   * Release is idempotent: destroy() is called from finally blocks that can run
   * twice, and a double release would inflate the pool past its ceiling -
   * silently, and only under the load the cap exists to handle.
   */
  #releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active--;
      const next = this.#queue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve();
      }
    };
  }
}

/**
 * Wraps a provider so every sandbox it creates counts against `limiter`.
 *
 * The limiter is passed in rather than read from the environment so that a
 * process which builds several providers - one per run, as the engine does -
 * shares one ceiling instead of getting one each.
 */
export function withSandboxLimit(
  provider: SandboxProvider,
  limiter: SandboxLimiter,
): SandboxProvider {
  const releases = new Map<string, () => void>();

  return new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop === "create") {
        return async (spec: SandboxSpec): Promise<Sandbox> => {
          const release = await limiter.acquire(spec.name, target.name);
          try {
            const box = await target.create(spec);
            releases.set(box.id, release);
            return box;
          } catch (err) {
            // The slot was never used; give it back rather than leaking it.
            release();
            throw err;
          }
        };
      }

      if (prop === "destroy") {
        return async (id: string): Promise<void> => {
          try {
            await target.destroy(id);
          } finally {
            releases.get(id)?.();
            releases.delete(id);
          }
        };
      }

      if (prop === "destroyAll") {
        return async (): Promise<void> => {
          try {
            await target.destroyAll?.();
          } finally {
            for (const release of releases.values()) release();
            releases.clear();
          }
        };
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * The ceiling for this process.
 *
 * Per-process, not per-deployment: two orchestrators each get their own, so a
 * multi-instance deployment should divide its budget between them.
 */
let shared: SandboxLimiter | undefined;

export function sharedSandboxLimiter(env: NodeJS.ProcessEnv = process.env): SandboxLimiter {
  shared ??= new SandboxLimiter({
    max: Number(env.MAX_CONCURRENT_SANDBOXES ?? 12),
    waitMs: Number(env.SANDBOX_SLOT_WAIT_MS ?? 120_000),
  });
  return shared;
}

/** Test seam: forgets the process-wide limiter. */
export function resetSharedSandboxLimiter() {
  shared = undefined;
}
