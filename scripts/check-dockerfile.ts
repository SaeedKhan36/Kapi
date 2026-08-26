/**
 * Checks that every path the Dockerfile copies actually exists.
 *
 * Not a substitute for building the image - it cannot catch a bad base image,
 * a missing apk package, or a broken RUN. It does catch the failure that
 * actually happens in practice: a COPY naming a file that was renamed, moved,
 * or never produced by the build, which surfaces as a broken image minutes
 * into CI rather than instantly here.
 *
 * Run after `pnpm build`, so the build outputs it references exist.
 */
import { existsSync, readFileSync } from "node:fs";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "\x1b[32mok  \x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${extra ? `  | ${extra}` : ""}`);
  if (!cond) failures++;
};

const dockerfile = readFileSync("Dockerfile", "utf8");

console.log("\n\x1b[1mDockerfile\x1b[0m\n");

// --- manifests copied in the dependency layer -----------------------------
const manifests = [...dockerfile.matchAll(/^COPY ((?:apps|packages)\/[\w-]+\/package\.json)/gm)]
  .map((m) => m[1]);
check("dependency layer copies manifests", manifests.length > 0, `${manifests.length} found`);
for (const p of manifests) check(`exists: ${p}`, existsSync(p));

// Every workspace package must be in that list, or pnpm install --frozen-lockfile
// fails inside the image with a lockfile mismatch that is hard to read.
const declared = new Set(manifests.map((p) => p.replace(/\/package\.json$/, "")));
const onDisk = [
  ...readFileSync("pnpm-workspace.yaml", "utf8").matchAll(/"([^"]+)"/g),
].map((m) => m[1]);
check("workspace globs are apps/* and packages/*", onDisk.length === 2, onDisk.join(", "));

const { readdirSync } = await import("node:fs");
const expected = [
  ...readdirSync("apps").map((d) => `apps/${d}`),
  ...readdirSync("packages").map((d) => `packages/${d}`),
].filter((d) => existsSync(`${d}/package.json`));

const missing = expected.filter((d) => !declared.has(d));
check("every workspace package is copied", missing.length === 0, missing.join(", ") || "all present");

// --- build outputs copied into the runtime stages -------------------------
const outputs = [...dockerfile.matchAll(/^COPY --from=build (\/app\/\S+)/gm)]
  .flatMap((m) => m[1].split(/\s+/))
  .map((p) => p.replace(/^\/app\//, ""))
  .filter((p) => p !== "");

check("runtime stages copy build output", outputs.length > 0, `${outputs.length} paths`);
for (const p of new Set(outputs)) {
  check(`build produces: ${p}`, existsSync(p), existsSync(p) ? "" : "run `pnpm build` first");
}

// --- the things that make a container behave -------------------------------
check("runs as a non-root user", /^USER node$/m.test(dockerfile));
check("has an init process for signal handling", /tini/.test(dockerfile),
  "without one, PID 1 ignores SIGTERM and sandboxes leak");
check("declares a healthcheck", /HEALTHCHECK/.test(dockerfile));
check("pins a base image tag", /^FROM node:\d+/m.test(dockerfile));
check("builds an agent image", /^FROM node:.* AS agent/m.test(dockerfile));
check("final image is the hosted process", /FROM base AS hosted[\s\S]*CMD \["node", "deploy\/start-hosted.mjs"\]/.test(dockerfile));

const compose = readFileSync("docker-compose.yml", "utf8");
console.log("\n\x1b[1mdocker compose\x1b[0m\n");
check("compose proxies /api through the dashboard", /ORCHESTRATOR_URL:\s*http:\/\/orchestrator:8787/.test(compose));
check("compose includes Postgres", /image:\s*postgres:/.test(compose));
check("compose builds kapi/agent:latest", /target:\s*agent/.test(compose) && /kapi\/agent:latest/.test(compose));

console.log(failures === 0 ? "\n\x1b[32mALL PASS\x1b[0m\n" : `\n\x1b[31m${failures} FAILED\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
