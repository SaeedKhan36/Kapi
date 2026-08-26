import { z } from "zod";
import type { LLMProvider, LlmMessage } from "@kapi/llm";
import type { CodingContext, CodingEngine, CodingResult, CodingTask } from "../types.ts";
import { changedFiles, commitAll, commitsSince, currentCommit } from "../git-ops.ts";

const ToolCallSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("list_files"), dir: z.string().default(".") }),
  z.object({ tool: z.literal("read_file"), path: z.string() }),
  z.object({ tool: z.literal("write_file"), path: z.string(), content: z.string() }),
  z.object({ tool: z.literal("run_command"), command: z.string() }),
  z.object({ tool: z.literal("finish"), summary: z.string() }),
]);
type ToolCall = z.infer<typeof ToolCallSchema>;

/**
 * A batch of actions to run in order.
 *
 * One request per tool call is ruinous on a free tier capped at 20 requests per
 * model per day: scaffolding a project means a dozen file writes, and each
 * would cost a twentieth of the daily budget. Batching independent actions into
 * a single response cuts request count several-fold with no loss of control,
 * because the agent still sees every result before deciding what to do next.
 */
const ActionBatchSchema = z.object({
  actions: z.array(ToolCallSchema).min(1).max(12),
});
type ActionBatch = z.infer<typeof ActionBatchSchema>;

/** One action and its result, so old turns can be summarised without losing the trail. */
type Turn = { call: string; label: string; observation: string; failed: boolean };

const SYSTEM = `You are a Worker Agent: a focused software engineer implementing exactly one task inside an isolated sandbox on your own git branch.

Work by emitting a BATCH of actions as JSON. You will be shown every result, then you emit the next batch:

  {"actions": [ {...}, {...} ]}

Tools:
  {"tool":"list_files","dir":"src"}                       list files under a directory
  {"tool":"read_file","path":"src/app.ts"}                read a file before editing it
  {"tool":"write_file","path":"src/app.ts","content":"…"} write the COMPLETE new file contents
  {"tool":"run_command","command":"npm test"}             run a shell command in the repo root
  {"tool":"finish","summary":"what you changed"}          finish, only when the task is done

Batching rules — these matter, every request is scarce:
- Put every action you can already decide on into ONE batch. Writing eight files
  you have fully planned is one batch, not eight requests.
- Batch actions run in order and do not stop on failure, so only batch work
  whose inputs you already know.
- Do NOT batch an action whose content depends on the result of an earlier one.
  Read first, see the result, then write in the next batch.
- A good rhythm: batch 1 explores (list + read), batch 2 writes everything,
  batch 3 verifies with a command, batch 4 finishes.
- "finish" must be the last action in its batch.

Rules:
- ALWAYS read a file before overwriting it. write_file replaces the whole file, so
  reproduce the parts you are not changing.
- Honour the shared contract exactly. Other engineers are building against it in
  parallel; changing an agreed interface breaks their work.
- Match the surrounding code's style, imports, and conventions.
- Verify your work with run_command (build, tests, linters) before finishing.
- STAY IN SCOPE. Change only the files your task requires. Teammates are editing
  other files in parallel; touching theirs creates merge conflicts and undoes
  their work. If your task is documentation, edit documentation - not source.
- Call finish as soon as the acceptance criteria are met. Do not keep polishing.
- Do not run git commands; commits are handled for you.
- Emit ONLY the JSON object {"actions":[...]}. No prose, no fences.`;

/**
 * A self-contained coding loop built on the LLMProvider we already have.
 *
 * Chosen over shelling out to Aider/OpenCode for day one because it needs no
 * per-sandbox install (a `pip install` on every sandbox start is minutes of
 * latency and a Python version constraint), and it behaves identically across
 * the local, Docker, and Daytona providers.
 */
export class DirectEngine implements CodingEngine {
  readonly name = "direct";

  constructor(
    private llm: LLMProvider,
    private opts: {
      maxIterations?: number;
      commandTimeoutMs?: number;
      maxObservationChars?: number;
      /** How many recent turns keep their full observation text. */
      keepFullTurns?: number;
    } = {},
  ) {}

  /**
   * Rebuilds the prompt from the task brief plus a sliding window of turns.
   *
   * Appending every observation forever is what makes a long agent loop
   * expensive: cost grows quadratically with steps, and a free-tier daily quota
   * disappears in a single run. Older turns keep the ACTION (so the agent still
   * knows what it already tried) but drop the payload.
   */
  #buildMessages(brief: LlmMessage, turns: Turn[], keepFull: number): LlmMessage[] {
    const messages: LlmMessage[] = [brief];
    const cutoff = Math.max(0, turns.length - keepFull);

    if (cutoff > 0) {
      const summary = turns.slice(0, cutoff)
        .map((t, i) => `${i + 1}. ${t.label}${t.failed ? "  [failed]" : ""}`)
        .join("\n");
      messages.push({
        role: "user",
        content: `Steps you have already taken (results omitted to save context):\n${summary}`,
      });
    }

    for (const turn of turns.slice(cutoff)) {
      messages.push({ role: "assistant", content: turn.call });
      messages.push({ role: "user", content: `Result:\n${turn.observation}` });
    }
    return messages;
  }

  async ensureInstalled() {
    // Nothing to install - the loop runs in the orchestrator, tools run in the sandbox.
  }

  /** Executes one action against the sandbox and returns what the agent should see. */
  async #runAction(
    ctx: CodingContext, call: ToolCall, cmdTimeout: number,
  ): Promise<{ observation: string; failed: boolean }> {
    const { provider, sandboxId, cwd } = ctx;

    switch (call.tool) {
      case "finish":
        return { observation: "", failed: false };

      case "list_files": {
        const res = await provider.exec(
          sandboxId,
          `find ${JSON.stringify(call.dir)} -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | head -200`,
          { cwd },
        );
        return { observation: res.stdout || "(empty)", failed: false };
      }

      case "read_file": {
        try {
          const body = await provider.readFile(sandboxId, `${cwd}/${call.path}`);
          return { observation: body.trim() ? body : "(file is empty)", failed: false };
        } catch (err) {
          return {
            observation: `ERROR: cannot read ${call.path}: ${err instanceof Error ? err.message : String(err)}`,
            failed: true,
          };
        }
      }

      case "write_file": {
        try {
          await provider.writeFile(sandboxId, `${cwd}/${call.path}`, call.content);
          return { observation: `wrote ${call.path} (${call.content.split("\n").length} lines)`, failed: false };
        } catch (err) {
          return {
            observation: `ERROR: cannot write ${call.path}: ${err instanceof Error ? err.message : String(err)}`,
            failed: true,
          };
        }
      }

      case "run_command": {
        if (/^\s*git\s+/.test(call.command)) {
          return { observation: "ERROR: git is managed for you. Do not run git commands.", failed: true };
        }
        const res = await provider.exec(sandboxId, call.command, { cwd, timeoutMs: cmdTimeout });
        return {
          observation: [
            `exit code: ${res.exitCode}`,
            res.stdout && `stdout:\n${res.stdout}`,
            res.stderr && `stderr:\n${res.stderr}`,
          ].filter(Boolean).join("\n"),
          failed: res.exitCode !== 0,
        };
      }
    }
  }

  async runTask(ctx: CodingContext, task: CodingTask): Promise<CodingResult> {
    // Counts REQUESTS now, not individual actions - each request may carry a batch.
    const maxIterations = this.opts.maxIterations ?? Number(process.env.KAPI_MAX_REQUESTS_PER_TASK ?? 10);
    const cmdTimeout = this.opts.commandTimeoutMs ?? 180_000;
    const maxObs = this.opts.maxObservationChars ?? 6_000;

    const { provider, sandboxId, cwd } = ctx;
    const baseCommit = await currentCommit(provider, sandboxId, cwd);
    const log: string[] = [];
    const say = (line: string) => { log.push(line); ctx.onLog?.(line); };

    const brief: LlmMessage = {
      role: "user",
      content: [
        `# Your task: ${task.title}`,
        "",
        task.instruction,
        "",
        task.acceptance.length ? `## Acceptance criteria\n${task.acceptance.map((a) => `- ${a}`).join("\n")}` : "",
        "",
        "## Shared contract (agreed across the team - do not deviate)",
        task.contract,
        "",
        task.touches.length ? `## Files you will likely need\n${task.touches.map((f) => `- ${f}`).join("\n")}` : "",
        "",
        "Begin. Emit your first tool call.",
      ].filter(Boolean).join("\n"),
    };

    let summary = "";
    let finished = false;
    let aborted: string | null = null;
    const turns: Turn[] = [];
    const keepFull = this.opts.keepFullTurns ?? 6;

    for (let i = 1; i <= maxIterations && !finished; i++) {
      const remaining = maxIterations - i;
      const prompt = this.#buildMessages(brief, turns, keepFull);

      // Near the cap, stop asking for more work and ask for a landing.
      if (remaining <= 1) {
        prompt.push({
          role: "user",
          content:
            `You have ${remaining + 1} request(s) left. Do not start anything new. ` +
            `If the task is done, finish now. If it is not, finish and state plainly ` +
            `in the summary what remains.`,
        });
      }

      let batch: ActionBatch;
      try {
        const { value } = await this.llm.generateStructured(prompt, ActionBatchSchema, {
          tier: "coding",
          system: SYSTEM,
          temperature: 0.1,
          maxOutputTokens: 32_768,
        });
        batch = value;
      } catch (err) {
        aborted = err instanceof Error ? err.message : String(err);
        say(`[engine] aborted at request ${i}: ${aborted}`);
        break;
      }

      say(`[request ${i}/${maxIterations}] ${batch.actions.length} action(s)`);

      for (const call of batch.actions) {
        const label = call.tool === "run_command" ? `run_command: ${call.command}`
          : "path" in call ? `${call.tool}: ${call.path}`
          : call.tool;
        say(`   · ${label}`);

        const { observation, failed } = await this.#runAction(ctx, call, cmdTimeout);

        if (call.tool === "finish") {
          summary = call.summary;
          finished = true;
          break;
        }

        const trimmed = observation.length > maxObs
          ? observation.slice(0, maxObs) + `\n... [truncated, ${observation.length - maxObs} more chars]`
          : observation;

        turns.push({ call: JSON.stringify(call), label, observation: trimmed, failed });
      }
    }

    if (!finished) {
      if (aborted) {
        summary ||= `Stopped after ${turns.length} step(s) on "${task.title}": ${aborted}`;
      } else {
        say(`[engine] hit the ${maxIterations}-request limit without finishing`);
        summary ||= `Reached the ${maxIterations}-request limit before completing "${task.title}".`;
      }
    }

    await commitAll(provider, sandboxId, cwd, `${task.title}\n\n${summary}`.trim());
    const files = await changedFiles(provider, sandboxId, cwd, baseCommit);
    const commits = await commitsSince(provider, sandboxId, cwd, baseCommit);

    return {
      ok: finished && files.length > 0,
      // Distinguishes "the agent stopped on purpose" from "we cut it off":
      // a capped run can still leave a reviewable branch.
      incomplete: !finished,
      filesChanged: files,
      commits,
      summary: summary || "no summary produced",
      log: log.join("\n"),
    };
  }
}
