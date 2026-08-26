import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import type {
  ExecOptions, ExecResult, LogChunk, Sandbox, SandboxProvider, SandboxSpec,
} from "../types.ts";
import { SandboxError } from "../types.ts";

/**
 * Runs agents as local subprocesses in an isolated temp directory.
 *
 * This is the fast development loop: no Docker daemon, no cloud account, no
 * cold start. It gives filesystem separation (each agent gets its own clone and
 * its own branch) but NOT security isolation - the process can reach the host.
 * Use it for developing orchestration logic; use Daytona or Docker whenever the
 * agent is running code we did not write.
 */
export class LocalProvider implements SandboxProvider {
  readonly name = "local";
  #boxes = new Map<string, Sandbox>();
  /** Sandbox-scoped env from SandboxSpec, merged into every exec. */
  #env = new Map<string, Record<string, string>>();

  async isAvailable() {
    return true;
  }

  async create(spec: SandboxSpec): Promise<Sandbox> {
    const safe = spec.name.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 48);
    const root = await mkdtemp(join(tmpdir(), `kapi-${safe}-`));
    const workdir = join(root, "workspace");
    await mkdir(workdir, { recursive: true });

    const box: Sandbox = { id: root, provider: this.name, workdir, createdAt: Date.now() };
    this.#boxes.set(root, box);
    this.#env.set(root, spec.env ?? {});
    return box;
  }

  #box(id: string): Sandbox {
    const box = this.#boxes.get(id);
    if (!box) throw new SandboxError(`unknown sandbox ${id}`, this.name);
    return box;
  }

  /**
   * The environment an agent command runs with.
   *
   * Inheriting `process.env` wholesale would hand the agent every secret the
   * orchestrator holds - GITHUB_TOKEN, WORKOS_API_KEY, GITHUB_APP_PRIVATE_KEY,
   * DAYTONA_API_KEY, DATABASE_URL - which defeats the point of never putting a
   * credential in a sandbox's environment in the first place. The coding
   * engine runs model-chosen shell commands against repository contents, so
   * that is one `echo` away from a prompt injection.
   *
   * An allowlist rather than a denylist, because a denylist is wrong the day
   * someone adds a new key. Commands run under `bash -lc`, so the login shell
   * re-establishes anything toolchain-specific (nvm, asdf, homebrew) from the
   * user's profile.
   */
  #baseEnv(): Record<string, string> {
    const allowed = [
      "PATH", "HOME", "USER", "LOGNAME", "SHELL",
      "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ",
    ];
    const env: Record<string, string> = {};
    for (const key of allowed) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    return env;
  }

  /** Reject paths that escape the sandbox root via `..` or absolute paths. */
  #resolveInside(box: Sandbox, path: string): string {
    const target = isAbsolute(path) ? path : resolve(box.workdir, path);
    const rel = relative(box.workdir, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new SandboxError(`path escapes sandbox: ${path}`, this.name);
    }
    return target;
  }

  /**
   * Spawns directly rather than draining execStream: sharing exit-code state
   * between the two would race whenever two commands run concurrently in one sandbox.
   */
  async exec(id: string, cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const box = this.#box(id);
    const cwd = opts.cwd ? this.#resolveInside(box, opts.cwd) : box.workdir;
    const started = Date.now();

    return new Promise<ExecResult>((resolveExec) => {
      const child = spawn("bash", ["-lc", cmd], {
        cwd,
        env: { ...this.#baseEnv(), ...this.#env.get(id), ...opts.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolveExec({ exitCode, stdout, stderr, durationMs: Date.now() - started });
      };

      const timer = opts.timeoutMs
        ? setTimeout(() => {
            stderr += `\n[kapi] command exceeded ${opts.timeoutMs}ms, killed\n`;
            child.kill("SIGKILL");
          }, opts.timeoutMs)
        : null;

      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => {
        stderr += String(err);
        finish(127);
      });
      child.on("close", (code) => finish(code ?? 0));
    });
  }

  async *execStream(id: string, cmd: string, opts: ExecOptions = {}): AsyncIterable<LogChunk> {
    const box = this.#box(id);
    const cwd = opts.cwd ? this.#resolveInside(box, opts.cwd) : box.workdir;

    const child = spawn("bash", ["-lc", cmd], {
      cwd,
      env: { ...this.#baseEnv(), ...this.#env.get(id), ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const queue: LogChunk[] = [];
    let done = false;
    let exitCode = 0;
    let wake: (() => void) | null = null;
    const push = (chunk: LogChunk) => {
      queue.push(chunk);
      wake?.();
      wake = null;
    };

    child.stdout.on("data", (d) => push({ stream: "stdout", data: d.toString() }));
    child.stderr.on("data", (d) => push({ stream: "stderr", data: d.toString() }));

    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs)
      : null;

    child.on("close", (code) => {
      exitCode = code ?? 0;
      done = true;
      wake?.();
      wake = null;
    });
    child.on("error", (err) => {
      push({ stream: "stderr", data: String(err) });
      exitCode = 127;
      done = true;
      wake?.();
      wake = null;
    });

    try {
      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((r) => (wake = r));
          continue;
        }
        yield queue.shift()!;
      }
      if (exitCode !== 0) {
        yield { stream: "stderr", data: `\n[kapi] exited with code ${exitCode}\n` };
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async writeFile(id: string, path: string, content: string) {
    const target = this.#resolveInside(this.#box(id), path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  async readFile(id: string, path: string) {
    return readFile(this.#resolveInside(this.#box(id), path), "utf8");
  }

  async destroy(id: string) {
    const box = this.#boxes.get(id);
    if (!box) return;
    await rm(box.id, { recursive: true, force: true });
    this.#boxes.delete(id);
    this.#env.delete(id);
  }

  async destroyAll() {
    await Promise.all([...this.#boxes.keys()].map((id) => this.destroy(id)));
  }
}
