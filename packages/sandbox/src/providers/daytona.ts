import type {
  ExecOptions, ExecResult, LogChunk, Sandbox, SandboxProvider, SandboxSpec,
} from "../types.ts";
import { SandboxError } from "../types.ts";

/**
 * Daytona Cloud - real isolation, ~90ms starts.
 *
 * NOTE ON COST: Daytona is billed per second (~$0.08/hr for 1 vCPU / 2GiB) with
 * $200 of trial credit, not a perpetual free tier. Idle sandboxes quietly burn
 * that credit, so `idleTtlSeconds` is always set and `destroy` is called in a
 * finally block by callers.
 *
 * This file is the ONLY place the Daytona SDK may be imported.
 */
export class DaytonaProvider implements SandboxProvider {
  readonly name = "daytona";
  #client: any = null;
  #boxes = new Map<string, { handle: any; box: Sandbox }>();

  constructor(private apiKey = process.env.DAYTONA_API_KEY) {}

  async isAvailable() {
    if (!this.apiKey) return false;
    try {
      await import("@daytonaio/sdk");
      return true;
    } catch {
      return false;
    }
  }

  async #sdk() {
    if (this.#client) return this.#client;
    if (!this.apiKey) throw new SandboxError("DAYTONA_API_KEY is not set", this.name);
    let mod: any;
    try {
      mod = await import("@daytonaio/sdk");
    } catch (cause) {
      throw new SandboxError(
        "@daytonaio/sdk is not installed - run: pnpm add -w @daytonaio/sdk",
        this.name,
        cause,
      );
    }
    const Daytona = mod.Daytona ?? mod.default?.Daytona;
    this.#client = new Daytona({ apiKey: this.apiKey });
    return this.#client;
  }

  async create(spec: SandboxSpec): Promise<Sandbox> {
    const daytona = await this.#sdk();
    try {
      const handle = await daytona.create({
        language: "typescript",
        image: spec.image,
        envVars: spec.env,
        autoStopInterval: Math.max(1, Math.round((spec.idleTtlSeconds ?? 900) / 60)),
        resources: {
          cpu: spec.cpus ?? 1,
          memory: Math.round((spec.memoryMb ?? 2048) / 1024),
        },
      });
      const id = handle.id ?? handle.sandboxId;
      const workdir = spec.workdir ?? "/home/daytona/workspace";
      const box: Sandbox = { id, provider: this.name, workdir, createdAt: Date.now() };
      this.#boxes.set(id, { handle, box });
      await this.exec(id, `mkdir -p ${workdir}`);
      return box;
    } catch (cause) {
      throw new SandboxError(`failed to create sandbox: ${String(cause)}`, this.name, cause);
    }
  }

  #handle(id: string) {
    const entry = this.#boxes.get(id);
    if (!entry) throw new SandboxError(`unknown sandbox ${id}`, this.name);
    return entry;
  }

  async exec(id: string, cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const { handle, box } = this.#handle(id);
    const started = Date.now();
    const cwd = opts.cwd ?? box.workdir;
    const envPrefix = Object.entries(opts.env ?? {})
      .map(([k, v]) => `export ${k}=${JSON.stringify(v)};`)
      .join(" ");
    const res = await handle.process.executeCommand(
      `${envPrefix} cd ${cwd} && ${cmd}`,
      cwd,
      undefined,
      opts.timeoutMs ? Math.ceil(opts.timeoutMs / 1000) : undefined,
    );
    return {
      exitCode: res.exitCode ?? 0,
      stdout: res.result ?? res.stdout ?? "",
      stderr: res.stderr ?? "",
      durationMs: Date.now() - started,
    };
  }

  /** Daytona's exec is request/response; emit the buffered result as one chunk. */
  async *execStream(id: string, cmd: string, opts: ExecOptions = {}): AsyncIterable<LogChunk> {
    const res = await this.exec(id, cmd, opts);
    if (res.stdout) yield { stream: "stdout", data: res.stdout };
    if (res.stderr) yield { stream: "stderr", data: res.stderr };
  }

  async writeFile(id: string, path: string, content: string) {
    const { handle, box } = this.#handle(id);
    const abs = path.startsWith("/") ? path : `${box.workdir}/${path}`;
    const buf = Buffer.from(content, "utf8");
    if (handle.fs?.uploadFile) await handle.fs.uploadFile(buf, abs);
    else await this.exec(id, `mkdir -p "$(dirname ${abs})" && cat > ${abs} <<'KAPI_EOF'\n${content}\nKAPI_EOF`);
  }

  async readFile(id: string, path: string) {
    const { handle, box } = this.#handle(id);
    const abs = path.startsWith("/") ? path : `${box.workdir}/${path}`;
    if (handle.fs?.downloadFile) {
      const buf = await handle.fs.downloadFile(abs);
      return Buffer.from(buf).toString("utf8");
    }
    return (await this.exec(id, `cat ${abs}`)).stdout;
  }

  async destroy(id: string) {
    const entry = this.#boxes.get(id);
    if (!entry) return;
    try {
      await (entry.handle.delete?.() ?? entry.handle.remove?.());
    } finally {
      this.#boxes.delete(id);
    }
  }

  async destroyAll() {
    await Promise.all([...this.#boxes.keys()].map((id) => this.destroy(id)));
  }
}
