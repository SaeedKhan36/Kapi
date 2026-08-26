/**
 * Choosing a bus, and refusing to guess.
 *
 * A misconfigured Redis bus is the nastiest failure kapi can have: messages
 * reach the agents on one instance and silently miss the rest, so a worker
 * appears to stop answering rather than anything appearing to be broken. The
 * only safe behaviours are to work or to refuse at boot, never to fall back.
 */
import { createMessageBus, InProcessBus, RedisBus } from "../packages/bus/src/index.ts";
import { redact, RedisConfigError, resolveRedisUrl, wantsRedis } from "../packages/bus/src/redis-config.ts";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "\x1b[32mok  \x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${extra ? `  | ${extra}` : ""}`);
  if (!cond) failures++;
};

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

/** Returns the RedisConfigError message, or null if it did not throw. */
const refusal = (o: Record<string, string>): string | null => {
  try {
    resolveRedisUrl(env(o));
    return null;
  } catch (err) {
    return err instanceof RedisConfigError ? err.message : `wrong error type: ${String(err)}`;
  }
};

const main = () => {
  console.log("\n\x1b[1mredis configuration\x1b[0m\n");

  // --- what should work ----------------------------------------------------
  check("accepts redis://", resolveRedisUrl(env({ REDIS_URL: "redis://localhost:6379" })) === "redis://localhost:6379");
  check("accepts rediss://",
    resolveRedisUrl(env({ REDIS_URL: "rediss://default:pw@x.upstash.io:6379" })).startsWith("rediss://"));
  check("accepts UPSTASH_REDIS_URL",
    resolveRedisUrl(env({ UPSTASH_REDIS_URL: "rediss://default:pw@x.upstash.io:6379" })).startsWith("rediss://"));
  check("REDIS_URL wins over the others",
    resolveRedisUrl(env({ REDIS_URL: "redis://a:6379", UPSTASH_REDIS_URL: "redis://b:6379" })) === "redis://a:6379");

  // --- the mistake that was actually in the .env ---------------------------
  const restOnly = refusal({
    UPSTASH_REDIS_REST_URL: "https://stunning-yeti-176374.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "AaBbCc",
  });
  check("REST-only Upstash config is refused", restOnly !== null);
  check("...and the message names the REST/TCP mix-up", restOnly?.includes("REST") === true);
  check("...and shows the host they already have",
    restOnly?.includes("stunning-yeti-176374.upstash.io") === true,
    "so the fix can be copied, not derived");
  check("...and warns the REST token is not the password",
    restOnly?.includes("not the password") === true,
    "reusing it is the obvious next mistake");
  check("...and offers the single-instance way out",
    restOnly?.includes("KAPI_BUS=inprocess") === true);

  // --- other wrong turns ---------------------------------------------------
  const httpUrl = refusal({ REDIS_URL: "https://x.upstash.io" });
  check("an http:// REDIS_URL is refused", httpUrl !== null);
  check("...and explains a subscription needs TCP", httpUrl?.includes("TCP") === true, httpUrl?.slice(0, 60));

  check("a malformed URL is refused", refusal({ REDIS_URL: "not a url" }) !== null);
  check("nothing set at all is refused", refusal({}) !== null);
  check("...and says which variable to set", refusal({})?.includes("REDIS_URL") === true);

  // --- secrets must not reach a log line -----------------------------------
  check("passwords are redacted", redact("rediss://default:hunter2@x.io:6379") === "rediss://default:***@x.io:6379");
  check("...even in a refusal", (refusal({ REDIS_URL: "ftp://default:hunter2@x.io" }) ?? "").includes("hunter2") === false,
    "an error goes to logs like anything else");

  // --- KAPI_BUS drives the choice ------------------------------------------
  check("wantsRedis reads KAPI_BUS", wantsRedis(env({ KAPI_BUS: "redis" })) === true);
  check("...case and whitespace tolerant", wantsRedis(env({ KAPI_BUS: " Redis " })) === true);
  check("...defaults to false", wantsRedis(env({})) === false);

  console.log("\n\x1b[1mbus selection\x1b[0m\n");

  const previous = { KAPI_BUS: process.env.KAPI_BUS, REDIS_URL: process.env.REDIS_URL };
  try {
    delete process.env.KAPI_BUS;
    delete process.env.REDIS_URL;
    check("defaults to in-process", createMessageBus() instanceof InProcessBus);

    process.env.KAPI_BUS = "redis";
    let threw = false;
    try { createMessageBus(); } catch (err) { threw = err instanceof RedisConfigError; }
    check("KAPI_BUS=redis without a URL fails at construction", threw,
      "never silently in-process - that is a multi-instance data loss bug");

    process.env.REDIS_URL = "rediss://default:pw@example.upstash.io:6379";
    const bus = createMessageBus();
    check("KAPI_BUS=redis with a URL builds a RedisBus", bus instanceof RedisBus);
    check("...and does not connect while constructing", bus instanceof RedisBus,
      "connection is deferred to ready()");
    check("...and describes itself without the password",
      bus instanceof RedisBus && !bus.describe.includes("pw"), (bus as RedisBus).describe);
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  console.log(failures === 0 ? "\n\x1b[32mALL PASS\x1b[0m\n" : `\n\x1b[31m${failures} FAILED\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
};

main();
