/**
 * The caps that stop kapi spending more than it should.
 *
 * Two mechanisms with different jobs. The sandbox ceiling bounds what exists
 * at once, because Daytona bills per second and `maxConcurrency` only bounds a
 * single run. The HTTP limits bound what a caller may ask for, because a
 * hundred queued runs starve everyone else and burn a daily LLM quota on
 * planning before a sandbox is ever created.
 */
import { RateLimiter, RunAdmission } from "../apps/orchestrator/src/limits.ts";
import { LocalProvider, SandboxLimiter, SandboxLimitError, withSandboxLimit } from "../packages/sandbox/src/index.ts";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "\x1b[32mok  \x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${extra ? `  | ${extra}` : ""}`);
  if (!cond) failures++;
};

/** A provider that creates instantly and records how many boxes are live. */
class CountingProvider extends LocalProvider {
  live = 0;
  peak = 0;
  override async create(spec: Parameters<LocalProvider["create"]>[0]) {
    const box = await super.create(spec);
    this.live++;
    this.peak = Math.max(this.peak, this.live);
    return box;
  }
  override async destroy(id: string) {
    await super.destroy(id);
    this.live--;
  }
}

const main = async () => {
  console.log("\n\x1b[1msandbox ceiling\x1b[0m\n");

  {
    const inner = new CountingProvider();
    const limiter = new SandboxLimiter({ max: 3, waitMs: 5000 });
    const provider = withSandboxLimit(inner, limiter);

    // Twelve sandboxes wanted at once, three allowed. All should succeed, but
    // never more than three may exist together.
    const boxes = await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const box = await provider.create({ name: `box-${i}` });
        await new Promise((r) => setTimeout(r, 15));
        await provider.destroy(box.id);
        return box.id;
      }),
    );

    check("every request eventually gets a sandbox", boxes.length === 12);
    check("the ceiling is never exceeded", inner.peak <= 3, `peak was ${inner.peak}`);
    check("the ceiling is actually reached", inner.peak === 3, `peak was ${inner.peak}`);
    check("slots are returned when sandboxes are destroyed", limiter.active === 0,
      `${limiter.active} still held`);
    check("nothing is left waiting", limiter.waiting === 0);
  }

  // --- a worker holds a slot while its reviewer takes another ---------------
  {
    const limiter = new SandboxLimiter({ max: 2, waitMs: 3000 });
    const provider = withSandboxLimit(new CountingProvider(), limiter);

    const worker = await provider.create({ name: "worker" });
    const reviewer = await provider.create({ name: "reviewer" });
    check("nested acquisition works when there is room", limiter.active === 2,
      "a worker keeps its sandbox while the reviewer opens one");
    await provider.destroy(reviewer.id);
    await provider.destroy(worker.id);
    check("both slots come back", limiter.active === 0);
  }

  // --- and fails legibly rather than hanging when there is not --------------
  {
    const limiter = new SandboxLimiter({ max: 1, waitMs: 250 });
    const provider = withSandboxLimit(new CountingProvider(), limiter);

    const held = await provider.create({ name: "worker" });
    const started = Date.now();
    let error: unknown;
    try {
      await provider.create({ name: "reviewer" });
    } catch (err) {
      error = err;
    }
    const waited = Date.now() - started;

    check("an exhausted pool fails instead of hanging", error instanceof SandboxLimitError,
      error instanceof Error ? error.name : "no error thrown");
    check("...after the configured wait, not immediately", waited >= 200, `${waited}ms`);
    check("...and says how to fix it",
      String((error as Error)?.message).includes("MAX_CONCURRENT_SANDBOXES"));
    await provider.destroy(held.id);
  }

  // --- a failed creation must not leak its slot ----------------------------
  {
    const limiter = new SandboxLimiter({ max: 2, waitMs: 500 });
    class BrokenProvider extends LocalProvider {
      override async create(): Promise<never> { throw new Error("provider is down"); }
    }
    const provider = withSandboxLimit(new BrokenProvider(), limiter);

    for (let i = 0; i < 5; i++) {
      await provider.create({ name: `doomed-${i}` }).catch(() => {});
    }
    check("a failed create returns its slot", limiter.active === 0,
      `${limiter.active} leaked - the pool would shrink to nothing`);
  }

  // --- double destroy must not inflate the pool ----------------------------
  {
    const limiter = new SandboxLimiter({ max: 2, waitMs: 500 });
    const provider = withSandboxLimit(new CountingProvider(), limiter);
    const box = await provider.create({ name: "box" });
    await provider.destroy(box.id);
    await provider.destroy(box.id);
    check("releasing twice does not create a phantom slot", limiter.active === 0,
      `active=${limiter.active}`);
  }

  console.log("\n\x1b[1mrate limiting\x1b[0m\n");

  {
    const rate = new RateLimiter(3, 60);
    const now = Date.now();
    const first = [0, 1, 2].map(() => rate.take("alice", now));
    check("a burst is allowed through", first.every((d) => d.ok), "3 of 3");

    const fourth = rate.take("alice", now);
    check("...and then metered", !fourth.ok);
    check("...with a retry hint", !fourth.ok && fourth.retryAfterSeconds > 0,
      !fourth.ok ? `${fourth.retryAfterSeconds}s` : "");
    check("...that matches the configured rate", !fourth.ok && fourth.retryAfterSeconds <= 60,
      "60/hour is one a minute");

    check("another caller is unaffected", rate.take("bob", now).ok,
      "limits are per user, not global");

    check("tokens refill over time", rate.take("alice", now + 61_000).ok, "one minute later");
  }

  console.log("\n\x1b[1mconcurrent runs\x1b[0m\n");

  {
    const runs = new RunAdmission(3, 2);
    const a1 = runs.admit("alice");
    const a2 = runs.admit("alice");
    check("a user may run several at once", a1.ok && a2.ok);

    const a3 = runs.admit("alice");
    check("...up to their own limit", !a3.ok);
    check("...with a reason that names the cause",
      !a3.ok && a3.reason.includes("runs in progress"), !a3.ok ? a3.reason.slice(0, 48) : "");

    const b1 = runs.admit("bob");
    check("another user still gets in", b1.ok, "one user cannot starve the rest");

    const c1 = runs.admit("carol");
    check("...until the orchestrator is full", !c1.ok, `${runs.active} active`);
    check("...and that reason is different",
      !c1.ok && c1.reason.includes("configured maximum"), !c1.ok ? c1.reason.slice(0, 48) : "");

    if (a1.ok) a1.release();
    check("finishing a run frees a slot", runs.admit("carol").ok);

    if (a2.ok) { a2.release(); a2.release(); }
    check("releasing twice does not inflate capacity", runs.activeFor("alice") === 0,
      `alice has ${runs.activeFor("alice")}`);
  }

  console.log(failures === 0 ? "\n\x1b[32mALL PASS\x1b[0m\n" : `\n\x1b[31m${failures} FAILED\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
};

await main();
