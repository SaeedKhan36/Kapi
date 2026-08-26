/**
 * A sandbox must not inherit the orchestrator's secrets.
 *
 * The `local` provider runs agent commands as host processes. It was spawning
 * them with `{ ...process.env }`, so every credential the orchestrator holds -
 * the GitHub PAT, the WorkOS API key, the GitHub App private key, the Daytona
 * key, the database URL - was one `echo` away from a coding agent whose next
 * command is chosen by a model reading the repository it was pointed at.
 */
import { LocalProvider } from "../packages/sandbox/src/index.ts";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "\x1b[32mok  \x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${extra ? `  | ${extra}` : ""}`);
  if (!cond) failures++;
};

const SECRETS = {
  GITHUB_TOKEN: "ghp_ORCHESTRATOR_PAT",
  WORKOS_API_KEY: "sk_live_WORKOS",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
  DAYTONA_API_KEY: "dtn_KEY",
  DATABASE_URL: "postgresql://user:pw@host/db",
  GEMINI_API_KEY: "AIzaSyEXAMPLE",
  UPSTASH_REDIS_REST_TOKEN: "upstash_token",
};

const main = async () => {
  console.log("\n\x1b[1msandbox environment isolation\x1b[0m\n");

  for (const [k, v] of Object.entries(SECRETS)) process.env[k] = v;

  const provider = new LocalProvider();
  const box = await provider.create({
    name: "env-isolation",
    env: { KAPI_RUN_ID: "test", KAPI_AGENT_ID: "worker:backend" },
  });

  const dump = await provider.exec(box.id, "env");
  const seen = Object.keys(SECRETS).filter((k) => dump.stdout.includes(`${k}=`));
  check("no orchestrator secret reaches the sandbox", seen.length === 0, seen.join(", ") || "clean");

  const byValue = Object.entries(SECRETS).filter(([, v]) => dump.stdout.includes(v));
  check("no secret value leaks under another name", byValue.length === 0,
    byValue.map(([k]) => k).join(", ") || "clean");

  // The sandbox must still be a usable place to run a build.
  const shell = await provider.exec(box.id, "echo $KAPI_RUN_ID; test -n \"$PATH\" && echo has-path; test -n \"$HOME\" && echo has-home");
  check("run metadata still provided", shell.stdout.includes("test"), shell.stdout.trim().replace(/\n/g, " "));
  check("PATH survives", shell.stdout.includes("has-path"));
  check("HOME survives", shell.stdout.includes("has-home"), "git needs it for global config");

  const git = await provider.exec(box.id, "git --version");
  check("git is still runnable", git.exitCode === 0, git.stdout.trim());

  const node = await provider.exec(box.id, "node --version");
  check("node is still runnable", node.exitCode === 0, node.stdout.trim());

  // execStream shares the environment path and is easy to forget.
  let streamed = "";
  for await (const chunk of provider.execStream(box.id, "env")) streamed += chunk.data;
  const streamLeaks = Object.keys(SECRETS).filter((k) => streamed.includes(`${k}=`));
  check("execStream is isolated too", streamLeaks.length === 0, streamLeaks.join(", ") || "clean");

  await provider.destroy(box.id);
  for (const k of Object.keys(SECRETS)) delete process.env[k];

  console.log(failures === 0 ? "\n\x1b[32mALL PASS\x1b[0m\n" : `\n\x1b[31m${failures} FAILED\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
};

await main();
