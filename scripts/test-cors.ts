/**
 * CORS is open for a single operator and closed for everyone else.
 */
import { allowCorsOrigin, corsPolicy } from "../apps/orchestrator/src/cors.ts";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "\x1b[32mok  \x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${extra ? `  | ${extra}` : ""}`);
  if (!cond) failures++;
};

console.log("\n\x1b[1mcors\x1b[0m\n");

{
  const policy = corsPolicy({}, "none");
  check("single-operator reflects any origin", allowCorsOrigin("https://evil.example", policy) === "https://evil.example");
}

{
  const policy = corsPolicy({}, "clerk");
  check("multi-user with no allowlist refuses browsers", allowCorsOrigin("https://evil.example", policy) === undefined);
  check("…and still allows non-browser callers", allowCorsOrigin(undefined, policy) === undefined);
}

{
  const policy = corsPolicy({ KAPI_PUBLIC_URL: "https://kapi.example/" }, "clerk");
  check("KAPI_PUBLIC_URL becomes an allowed origin", policy.origins.includes("https://kapi.example"));
  check("…and only that origin is reflected", allowCorsOrigin("https://kapi.example", policy) === "https://kapi.example");
  check("…a stranger is not", allowCorsOrigin("https://evil.example", policy) === undefined);
}

{
  const policy = corsPolicy({
    KAPI_CORS_ORIGINS: "https://a.example, https://b.example",
    KAPI_PUBLIC_URL: "https://kapi.example",
  }, "none");
  check("an explicit list wins over open mode", policy.open === false);
  check("comma-separated origins are all kept", policy.origins.length === 3, policy.origins.join(" "));
}

console.log(failures === 0 ? "\n\x1b[32mALL PASS\x1b[0m\n" : `\n\x1b[31m${failures} FAILED\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
