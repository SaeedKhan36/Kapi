/**
 * Verifies that a GitHub credential never persists inside a sandbox.
 *
 * The threat this guards against is concrete: the coding engine executes
 * model-chosen shell commands against repository contents, so a token in the
 * environment or in .git/config is one `echo` away from a prompt injection
 * carried in the repo being worked on.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneRepo, LocalProvider, withGitAuth } from "../packages/sandbox/src/index.ts";

const TOKEN = "ghs_TESTTOKEN_must_never_persist_0123456789";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "\x1b[32mok  \x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${extra ? `  | ${extra}` : ""}`);
  if (!cond) failures++;
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A bare repo on disk, so the clone is real without needing the network. */
function makeOrigin(): string {
  const root = mkdtempSync(join(tmpdir(), "kapi-origin-"));
  const work = join(root, "work");
  const bare = join(root, "origin.git");
  execFileSync("git", ["init", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-b", "main", work]);
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "t");
  execFileSync("bash", ["-lc", `echo hello > ${work}/README.md`]);
  git(work, "add", "-A");
  git(work, "commit", "-m", "init");
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "-u", "origin", "main");
  return bare;
}

const main = async () => {
  console.log("\n\x1b[1mgit credential isolation\x1b[0m\n");

  const provider = new LocalProvider();
  const origin = makeOrigin();
  const box = await provider.create({ name: "git-auth-test", env: { KAPI_RUN_ID: "test" } });

  await cloneRepo(provider, box.id, {
    repoUrl: origin,
    branch: "main",
    token: TOKEN,
    identity: { name: "kapi-agent", email: "agent@kapi.local" },
    dir: "repo",
    depth: 0,
  });

  const cloned = await provider.exec(box.id, "test -f repo/README.md && echo yes");
  check("clone succeeded through withGitAuth", cloned.stdout.trim() === "yes");

  // --- the credential must not survive the operation -----------------------
  const config = await provider.exec(box.id, "cat repo/.git/config");
  check("token absent from .git/config", !config.stdout.includes(TOKEN));
  check("no x-access-token in remote URL", !config.stdout.includes("x-access-token"));

  const leftovers = await provider.exec(box.id, "ls -a | grep -c '^.kapi-auth-' || true");
  check("auth directory removed", leftovers.stdout.trim() === "0", `found ${leftovers.stdout.trim()}`);

  const anywhere = await provider.exec(box.id, `grep -rl ${JSON.stringify(TOKEN)} . 2>/dev/null | head -5`);
  check("token nowhere on the sandbox filesystem", anywhere.stdout.trim() === "",
    anywhere.stdout.trim() || "clean");

  const env = await provider.exec(box.id, "env | grep -E '^(GITHUB_TOKEN|GIT_ASKPASS)=' || true");
  check("no git credential in the sandbox environment", env.stdout.trim() === "", env.stdout.trim() || "clean");

  // --- the askpass shim answers correctly, and only what it should ---------
  await withGitAuth(provider, box.id, TOKEN, async (authEnv) => {
    check("GIT_TERMINAL_PROMPT disabled", authEnv.GIT_TERMINAL_PROMPT === "0");
    const askpass = authEnv.GIT_ASKPASS!;
    check("askpass path is absolute", askpass.startsWith("/"), askpass);

    const user = await provider.exec(box.id, `${askpass} "Username for 'https://github.com': "`);
    check("askpass answers Username", user.stdout.trim() === "x-access-token", user.stdout.trim());

    const pass = await provider.exec(box.id, `${askpass} "Password for 'https://x-access-token@github.com': "`);
    check("askpass answers Password with the token", pass.stdout.trim() === TOKEN);

    const other = await provider.exec(box.id, `${askpass} "something else"`);
    check("askpass refuses anything else", other.exitCode !== 0, `exit=${other.exitCode}`);

    // `ls -ld` rather than `stat`, whose flags differ between macOS and Linux.
    const authDir = askpass.replace(/\/askpass$/, "");
    const perms = await provider.exec(box.id, `ls -ld ${JSON.stringify(authDir)} | cut -c1-10`);
    check("credential directory is drwx------", perms.stdout.trim() === "drwx------", perms.stdout.trim());

    const credPerms = await provider.exec(box.id, `ls -l ${JSON.stringify(authDir)}/credential | cut -c1-10`);
    check("credential file is -rw-------", credPerms.stdout.trim() === "-rw-------", credPerms.stdout.trim());
  });

  const afterwards = await provider.exec(box.id, "ls -a | grep -c '^.kapi-auth-' || true");
  check("auth directory removed again after withGitAuth", afterwards.stdout.trim() === "0");

  // --- no token at all is a supported mode, not an error -------------------
  const noToken = await withGitAuth(provider, box.id, undefined, async (e) => e);
  check("without a token there is no askpass", noToken.GIT_ASKPASS === undefined);
  check("without a token prompts are still disabled", noToken.GIT_TERMINAL_PROMPT === "0");

  await provider.destroy(box.id);
  rmSync(origin.replace(/\/origin\.git$/, ""), { recursive: true, force: true });

  console.log(failures === 0 ? "\n\x1b[32mALL PASS\x1b[0m\n" : `\n\x1b[31m${failures} FAILED\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
};

await main();
