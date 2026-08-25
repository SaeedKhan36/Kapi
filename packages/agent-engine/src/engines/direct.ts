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

/** One action and its result, so old turns can be summarised without losing the trail. */
type Turn = { call: string; label: string; observation: string; failed: boolean };

const SYSTEM = `You are a Worker Agent: a focused software engineer implementing exactly one task inside an isolated sandbox on your own git branch.

Work by emitting ONE tool call at a time as JSON. You will be shown the result, then you emit the next call.

Tools:
  {"tool":"list_files","dir":"src"}                       list files under a directory
  {"tool":"read_file","path":"src/app.ts"}                read a file before editing it
  {"tool":"write_file","path":"src/app.ts","content":"…"} write the COMPLETE new file contents
  {"tool":"run_command","command":"npm test"}             run a shell command in the repo root
  {"tool":"finish","summary":"what you changed"}          finish, only when the task is done

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
- Emit ONLY the JSON object for the next tool call. No prose, no fences.`;

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

  async runTask(ctx: CodingContext, task: CodingTask): Promise<CodingResult> {
    const maxIterations = this.opts.maxIterations ?? Number(process.env.KAPI_MAX_STEPS ?? 32);
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
    const turns: Turn[] = [];
    const keepFull = this.opts.keepFullTurns ?? 6;

    for (let i = 1; i <= maxIterations && !finished; i++) {
      const remaining = maxIterations - i;
      const prompt = this.#buildMessages(brief, turns, keepFull);

      // Near the cap, stop asking for more work and ask for a landing.
      if (remaining <= 2) {
        prompt.push({
          role: "user",
          content:
            `You have ${remaining + 1} step(s) left. Do not start anything new. ` +
            `If the task is done, call finish now. If it is not, call finish and state plainly ` +
            `in the summary what remains.`,
        });
      }

      let call: ToolCall;
      try {
        const { value } = await this.llm.generateStructured(prompt, ToolCallSchema, {
          tier: "coding",
          system: SYSTEM,
          temperature: 0.1,
          maxOutputTokens: 16_384,
        });
        call = value;
      } catch (err) {
        say(`[engine] could not obtain a valid tool call: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }

      const label = call.tool === "run_command" ? `run_command: ${call.command}`
        : "path" in call ? `${call.tool}: ${call.path}`
        : call.tool;
      say(`[${i}/${maxIterations}] ${label}`);

      let observation: string;
      let failed = false;

      switch (call.tool) {
        case "finish":
          summary = call.summary;
          finished = true;
          observation = "";
          break;

        case "list_files": {
          const res = await provider.exec(
            sandboxId,
            `find ${JSON.stringify(call.dir)} -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | head -200`,
            { cwd },
          );
          observation = res.stdout || "(empty)";
          break;
        }

        case "read_file": {
          try {
            observation = await provider.readFile(sandboxId, `${cwd}/${call.path}`);
            if (!observation.trim()) observation = "(file is empty)";
          } catch (err) {
            failed = true;
            observation = `ERROR: cannot read ${call.path}: ${err instanceof Error ? err.message : String(err)}`;
          }
          break;
        }

        case "write_file": {
          try {
            await provider.writeFile(sandboxId, `${cwd}/${call.path}`, call.content);
            observation = `wrote ${call.path} (${call.content.split("\n").length} lines)`;
          } catch (err) {
            failed = true;
            observation = `ERROR: cannot write ${call.path}: ${err instanceof Error ? err.message : String(err)}`;
          }
          break;
        }

        case "run_command": {
          if (/^\s*git\s+/.test(call.command)) {
            failed = true;
            observation = "ERROR: git is managed for you. Do not run git commands.";
            break;
          }
          const res = await provider.exec(sandboxId, call.command, { cwd, timeoutMs: cmdTimeout });
          failed = res.exitCode !== 0;
          observation = [
            `exit code: ${res.exitCode}`,
            res.stdout && `stdout:\n${res.stdout}`,
            res.stderr && `stderr:\n${res.stderr}`,
          ].filter(Boolean).join("\n");
          break;
        }
      }

      if (finished) break;

      const trimmed = observation.length > maxObs
        ? observation.slice(0, maxObs) + `\n... [truncated, ${observation.length - maxObs} more chars]`
        : observation;

      turns.push({ call: JSON.stringify(call), label, observation: trimmed, failed });
    }

    if (!finished) {
      say(`[engine] stopped after ${maxIterations} iterations without finishing`);
      summary ||= `Reached the ${maxIterations}-step limit before completing "${task.title}".`;
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
