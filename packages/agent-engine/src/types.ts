import type { FileRef } from "@kapi/protocol";
import type { SandboxProvider } from "@kapi/sandbox";

export type CodingTask = {
  taskId: string;
  title: string;
  instruction: string;
  /** Rendered shared contract - the deadlock guard, injected into every task. */
  contract: string;
  acceptance: string[];
  /** Files the planner expects to be touched; used as a starting file set. */
  touches: string[];
};

export type CodingContext = {
  provider: SandboxProvider;
  sandboxId: string;
  /** Repo directory inside the sandbox. */
  cwd: string;
  onLog?: (line: string) => void;
};

export type CodingResult = {
  ok: boolean;
  filesChanged: FileRef[];
  commits: string[];
  summary: string;
  /** Raw engine output, retained for debugging and the UI. */
  log: string;
};

/**
 * The file-editing loop. Deliberately narrow so the orchestration layer never
 * depends on which agent binary is doing the work.
 */
export interface CodingEngine {
  readonly name: string;
  /** Installs the engine into a fresh sandbox. Idempotent. */
  ensureInstalled(ctx: CodingContext): Promise<void>;
  runTask(ctx: CodingContext, task: CodingTask): Promise<CodingResult>;
}
