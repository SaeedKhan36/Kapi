import type { CodingContext, CodingEngine, CodingResult, CodingTask } from "../types.ts";
import { shellQuote } from "@kapi/sandbox";
import { changedFiles, commitAll, commitsSince, currentCommit } from "../git-ops.ts";

/**
 * Wraps Aider running headless inside the sandbox.
 *
 * Kept as a second implementation to keep `CodingEngine` honest: if this stops
 * being swappable with DirectEngine, the abstraction has leaked. Requires
 * Python >= 3.10 in the sandbox image.
 */
export class AiderEngine implements CodingEngine {
  readonly name = "aider";
  #installed = new Set<string>();

  constructor(private opts: { model?: string; timeoutMs?: number } = {}) {}

  async ensureInstalled(ctx: CodingContext) {
    if (this.#installed.has(ctx.sandboxId)) return;
    const probe = await ctx.provider.exec(ctx.sandboxId, "command -v aider || true", { cwd: ctx.cwd });
    if (!probe.stdout.trim()) {
      ctx.onLog?.("[aider] installing (this takes a minute on a cold sandbox)");
      const res = await ctx.provider.exec(
        ctx.sandboxId,
        "python3 -m pip install --quiet --disable-pip-version-check aider-chat 2>&1",
        { timeoutMs: 600_000 },
      );
      if (res.exitCode !== 0) throw new Error(`aider install failed: ${res.stderr || res.stdout}`);
    }
    this.#installed.add(ctx.sandboxId);
  }

  async runTask(ctx: CodingContext, task: CodingTask): Promise<CodingResult> {
    await this.ensureInstalled(ctx);
    const { provider, sandboxId, cwd } = ctx;
    const baseCommit = await currentCommit(provider, sandboxId, cwd);

    const prompt = [
      task.instruction,
      "",
      "Shared contract (do not deviate):",
      task.contract,
      task.acceptance.length ? `\nAcceptance criteria:\n${task.acceptance.map((a) => `- ${a}`).join("\n")}` : "",
    ].join("\n");

    const model = this.opts.model ?? process.env.KAPI_AIDER_MODEL ?? "gemini/gemini-3.7-flash";
    const files = task.touches.map(shellQuote).join(" ");

    const res = await provider.exec(
      sandboxId,
      [
        "aider", "--yes-always", "--no-check-update", "--no-analytics",
        "--model", shellQuote(model),
        "--message", shellQuote(prompt),
        files,
      ].join(" ") + " 2>&1",
      {
        cwd,
        timeoutMs: this.opts.timeoutMs ?? 900_000,
        env: { GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? "" },
      },
    );

    await commitAll(provider, sandboxId, cwd, task.title);
    const changed = await changedFiles(provider, sandboxId, cwd, baseCommit);
    const commits = await commitsSince(provider, sandboxId, cwd, baseCommit);

    return {
      ok: res.exitCode === 0 && changed.length > 0,
      incomplete: false,
      filesChanged: changed,
      commits,
      summary: commits[0] ?? task.title,
      log: res.stdout + res.stderr,
    };
  }
}
