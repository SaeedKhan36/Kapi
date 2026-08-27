/**
 * What one caller may ask this orchestrator to do.
 *
 * The sandbox ceiling in @kapi/sandbox stops the process spending more than it
 * should. It does not stop one user queueing a hundred runs that then sit
 * waiting for slots, starving everyone else and burning a daily LLM quota on
 * planning calls before a single sandbox is created. That is what these are
 * for, and they sit at the HTTP boundary because that is where a caller exists.
 *
 * Per process, like the sandbox ceiling: two orchestrators each enforce their
 * own, so a multi-instance deployment should divide its budget between them.
 */
export type RateDecision =
  | { ok: true }
  | { ok: false; reason: string; retryAfterSeconds: number };

/**
 * A token bucket per caller.
 *
 * Chosen over a fixed window because a run is bursty by nature - someone
 * kicking off three related pieces of work in a minute is normal, and a window
 * that refuses the third is annoying in a way that a bucket, which lets a
 * burst through and then meters, is not.
 */
export class RateLimiter {
  #buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(
    /** Runs a caller may start back to back. */
    readonly burst: number,
    /** Sustained rate, once the burst is spent. */
    readonly perHour: number,
  ) {}

  take(key: string, now = Date.now()): RateDecision {
    const refillPerMs = this.perHour / 3_600_000;
    const bucket = this.#buckets.get(key) ?? { tokens: this.burst, updated: now };

    bucket.tokens = Math.min(this.burst, bucket.tokens + (now - bucket.updated) * refillPerMs);
    bucket.updated = now;

    if (bucket.tokens < 1) {
      const seconds = Math.ceil((1 - bucket.tokens) / refillPerMs / 1000);
      this.#buckets.set(key, bucket);
      return {
        ok: false,
        reason: `too many runs started. This deployment allows ${this.perHour} per hour.`,
        retryAfterSeconds: Math.max(1, seconds),
      };
    }

    bucket.tokens -= 1;
    this.#buckets.set(key, bucket);
    // Buckets at full strength carry no information; dropping them keeps a
    // long-lived process from remembering every caller it has ever seen.
    if (this.#buckets.size > 10_000) this.#prune(now);
    return { ok: true };
  }

  #prune(now: number) {
    const refillPerMs = this.perHour / 3_600_000;
    for (const [key, bucket] of this.#buckets) {
      const refilled = bucket.tokens + (now - bucket.updated) * refillPerMs;
      if (refilled >= this.burst) this.#buckets.delete(key);
    }
  }

  /** Test seam. */
  get tracked() { return this.#buckets.size; }
}

/**
 * How many runs may be underway at once, in total and per caller.
 *
 * Separate from the rate limit: a rate limit bounds how fast runs start, this
 * bounds how many exist. Without it, a user who starts one run an hour for ten
 * hours still ends up with ten running at once if none of them finish.
 */
export class RunAdmission {
  #active = new Map<string, number>();
  #total = 0;

  constructor(
    readonly maxTotal: number,
    readonly maxPerUser: number,
  ) {}

  get active() { return this.#total; }
  activeFor(userId: string) { return this.#active.get(userId) ?? 0; }

  /** Reserves a slot, or explains why not. Release when the run ends. */
  admit(userId: string): { ok: true; release: () => void } | { ok: false; reason: string } {
    if (this.#total >= this.maxTotal) {
      return {
        ok: false,
        reason:
          `this orchestrator is at its configured maximum of ${this.maxTotal} concurrent ` +
          "run(s). Try again when one finishes.",
      };
    }
    const mine = this.activeFor(userId);
    if (mine >= this.maxPerUser) {
      return {
        ok: false,
        reason: `you already have ${mine} runs in progress, which is the maximum. ` +
          "Wait for one to finish before starting another.",
      };
    }

    this.#total++;
    this.#active.set(userId, mine + 1);

    let released = false;
    return {
      ok: true,
      // Idempotent: a run can end through several paths and a double release
      // would let the process quietly exceed its own ceiling.
      release: () => {
        if (released) return;
        released = true;
        this.#total--;
        const remaining = this.activeFor(userId) - 1;
        if (remaining > 0) this.#active.set(userId, remaining);
        else this.#active.delete(userId);
      },
    };
  }
}

export type Limits = {
  rate: RateLimiter;
  runs: RunAdmission;
  /** The most workers any single run may hold at once. See `workerCeiling`. */
  maxWorkers: number;
  /** The most tasks any single run may be planned into. See `taskCeiling`. */
  maxTasks: number;
};

/**
 * The most workers one run may hold at once.
 *
 * A ceiling, not a default. `maxConcurrency` arrives on every HTTP request -
 * the schema fills it in when the caller omits it - so reading this variable
 * as a fallback meant it never applied to anything the dashboard started, and
 * a deployment sized for one worker handed out eight to whoever typed eight.
 * Sandboxes bill per second, so the deployment gets the last word over the
 * caller.
 */
export function workerCeiling(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MAX_CONCURRENT_WORKERS ?? 4);
  // A malformed value must not read as "no limit". NaN loses every comparison,
  // so `inFlight.size >= maxConcurrency` would never be true and the scheduler
  // would launch the entire graph at once.
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 4;
}

/**
 * The most tasks one run may be planned into.
 *
 * The sibling of `workerCeiling`, and the reason both exist: plan size decides
 * how many sandboxes a run creates over its life, where worker concurrency
 * only decides how many exist at any one moment. A twelve-task plan run one
 * worker at a time still buys twelve sandboxes, plus a reviewer each.
 *
 * Unlike the worker ceiling this cannot be enforced by clamping a number
 * alone: `maxTasks` reaches the planner as prompt text, and a model is free to
 * return more tasks than it was asked for. The engine trims the plan it gets
 * back. See `trimToTaskLimit`.
 */
export function taskCeiling(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MAX_TASKS_PER_RUN ?? 8);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 8;
}

/** Applies a ceiling to what a caller asked for. */
export function clampWorkers(requested: number | undefined, ceiling: number): number {
  return Math.min(requested ?? ceiling, ceiling);
}

/** As `clampWorkers`. Separate name so call sites read as what they bound. */
export function clampTasks(requested: number | undefined, ceiling: number): number {
  return Math.min(requested ?? ceiling, ceiling);
}

/**
 * Defaults sized for the free tiers kapi is built around: a Gemini key affords
 * roughly four to six runs a day, so twenty an hour is a guard rail rather
 * than a quota, and it exists to stop a loop, not to ration normal use.
 */
export function createLimits(env: NodeJS.ProcessEnv = process.env): Limits {
  return {
    rate: new RateLimiter(
      Number(env.MAX_RUN_BURST ?? 5),
      Number(env.MAX_RUNS_PER_HOUR ?? 20),
    ),
    runs: new RunAdmission(
      Number(env.MAX_CONCURRENT_RUNS ?? 5),
      Number(env.MAX_CONCURRENT_RUNS_PER_USER ?? 2),
    ),
    maxWorkers: workerCeiling(env),
    maxTasks: taskCeiling(env),
  };
}
