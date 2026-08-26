/**
 * Working out which Redis to talk to, and saying so plainly when it cannot.
 *
 * Separated from the bus itself because this is where the mistakes happen and
 * it is the part worth testing: a misconfigured bus does not fail, it quietly
 * delivers messages to one instance and not the others, which looks like an
 * agent that stopped replying rather than like a configuration error.
 */
export class RedisConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisConfigError";
  }
}

/** Variables that could plausibly hold a TCP Redis URL, in order of preference. */
const URL_VARS = ["REDIS_URL", "KAPI_REDIS_URL", "UPSTASH_REDIS_URL"] as const;

const TCP_PROTOCOLS = new Set(["redis:", "rediss:"]);

/**
 * The Redis connection string, or a refusal that says what to do.
 *
 * Upstash is the reason this is more than one line. Its console offers two
 * credentials that look interchangeable and are not: `UPSTASH_REDIS_REST_URL`
 * with a REST token speaks HTTP and cannot hold a subscription open, while the
 * bus needs the `rediss://` endpoint. Reaching for the REST pair is the
 * obvious mistake, so it gets its own answer rather than "REDIS_URL is not set".
 */
export function resolveRedisUrl(env: NodeJS.ProcessEnv = process.env): string {
  for (const name of URL_VARS) {
    const value = env[name]?.trim();
    if (!value) continue;

    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new RedisConfigError(`${name} is not a valid URL: ${redact(value)}`);
    }

    if (!TCP_PROTOCOLS.has(parsed.protocol)) {
      throw new RedisConfigError(
        `${name} must be a redis:// or rediss:// URL, but starts with ${parsed.protocol}//. ` +
        (parsed.protocol.startsWith("http")
          ? "That looks like a REST endpoint; the bus holds a subscription open and needs the TCP one."
          : "The bus speaks the Redis protocol, not HTTP."),
      );
    }
    return value;
  }

  // The specific wrong turn, named.
  if (env.UPSTASH_REDIS_REST_URL) {
    const host = hostOf(env.UPSTASH_REDIS_REST_URL);
    throw new RedisConfigError(
      "KAPI_BUS=redis, but only the Upstash REST credentials are set.\n\n" +
      "  UPSTASH_REDIS_REST_URL speaks HTTP, and a message bus has to keep a\n" +
      "  subscription open, so it needs the TCP endpoint instead. In the Upstash\n" +
      "  console the database page shows it under \"Redis\" / \"Node\" - it looks like\n\n" +
      `      rediss://default:<password>@${host ?? "<your-host>"}:6379\n\n` +
      "  Put that in REDIS_URL. The REST token is not the password; copy the\n" +
      "  password from the console rather than reusing UPSTASH_REDIS_REST_TOKEN.\n\n" +
      "  Or set KAPI_BUS=inprocess to run on a single orchestrator.",
    );
  }

  throw new RedisConfigError(
    "KAPI_BUS=redis, but REDIS_URL is not set.\n\n" +
    "  Set REDIS_URL to a redis:// or rediss:// connection string, or set\n" +
    "  KAPI_BUS=inprocess to run on a single orchestrator.",
  );
}

/** True when the deployment asked for Redis, whatever state its config is in. */
export const wantsRedis = (env: NodeJS.ProcessEnv = process.env) =>
  (env.KAPI_BUS ?? "inprocess").trim().toLowerCase() === "redis";

function hostOf(value: string): string | undefined {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

/** Never echo a credential back into a log line. */
export function redact(url: string): string {
  return url.replace(/\/\/([^:@/]*):[^@]*@/, "//$1:***@");
}
