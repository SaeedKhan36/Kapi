/**
 * The isolation boundary for one agent.
 *
 * Nothing outside providers/ may import a vendor SDK. Swapping Daytona for
 * self-hosted Docker (or anything else) must be a one-line config change.
 */
export type SandboxSpec = {
  /** Stable label, e.g. "kapi-<runId>-master". Providers may sanitise it. */
  name: string;
  image?: string;
  env?: Record<string, string>;
  /** Absolute path inside the sandbox where the repo lives. */
  workdir?: string;
  cpus?: number;
  memoryMb?: number;
  /** Auto-destroy after this many idle seconds. Guards against leaked spend. */
  idleTtlSeconds?: number;
};

export type Sandbox = {
  id: string;
  provider: string;
  workdir: string;
  createdAt: number;
};

export type ExecOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type LogChunk = { stream: "stdout" | "stderr"; data: string };

export interface SandboxProvider {
  readonly name: string;
  /** True when the provider's prerequisites (binary, API key) are present. */
  isAvailable(): Promise<boolean>;
  create(spec: SandboxSpec): Promise<Sandbox>;
  exec(id: string, cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  execStream(id: string, cmd: string, opts?: ExecOptions): AsyncIterable<LogChunk>;
  writeFile(id: string, path: string, content: string): Promise<void>;
  readFile(id: string, path: string): Promise<string>;
  destroy(id: string): Promise<void>;
  /** Best-effort cleanup of anything this process leaked. */
  destroyAll?(): Promise<void>;
}

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}
