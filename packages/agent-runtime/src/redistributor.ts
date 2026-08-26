import {
  RecoveryDecisionSchema, validateRecovery,
  type PlannedTask, type RecoveryDecision, type ReviewVerdict,
} from "@kapi/protocol";
import type { LLMProvider } from "@kapi/llm";

const REDISTRIBUTOR_SYSTEM = `You are the Master Agent deciding what to do about a task your team failed to complete.

Respond with JSON:
{
  "strategy": "retry" | "rescope" | "abandon",
  "reasoning": "why, referring to the actual failure",
  "guidance": "extra instruction for a retry",
  "replacementTasks": [ { "id","title","instruction","role","dependsOn","touches","acceptance" } ],
  "dependantsCanProceed": false
}

CHOOSE HONESTLY — each strategy costs the team time:

- "retry" when the worker was capable but went wrong in a fixable way: it ran out
  of steps, misread a file, missed a step it was told to take, or a reviewer
  raised something concrete. "guidance" MUST say specifically what to do
  differently. Never retry with a vague "try harder".

- "rescope" when the TASK was the problem: too large for one worker, resting on
  an assumption the repository contradicts, or two unrelated jobs in one. Split
  or reframe it into 1-3 replacement tasks. Replacements must be self-contained,
  must NOT depend on the failed task, and must not reuse its id.

- "abandon" when nothing in this run will fix it: a missing external credential,
  a service that is unavailable, or work the repository genuinely cannot support.
  Then decide "dependantsCanProceed": true only if the dependants' own work still
  makes sense without this task.

RULES:
- Look at the actual error and the worker's log. Diagnose the real cause; do not
  restate the task.
- Do not retry a task that has already been retried for the same reason. If the
  same failure recurs, rescope or abandon.
- Replacement tasks may depend on OTHER live tasks or on each other, never on
  the task being replaced.
- Prefer the smallest intervention that could actually work.`;

export type RecoveryInput = {
  task: PlannedTask;
  /** Everything known about why it failed. */
  failure: {
    summary: string;
    error?: string;
    log?: string;
    attempts: number;
    incomplete: boolean;
    review?: ReviewVerdict | null;
  };
  /** Task ids currently live in the run, for collision and dependency checks. */
  existingIds: string[];
  /** Tasks waiting on this one, so the master can weigh the blast radius. */
  dependants: string[];
  goal: string;
  contract: string;
};

const MAX_LOG_CHARS = 4_000;

/**
 * Asks the master what to do about one failure.
 *
 * Costs a single LLM request, and the caller bounds how many times per run —
 * an unbounded recovery loop is both an infinite loop and a quota fire.
 */
export async function decideRecovery(
  llm: LLMProvider,
  input: RecoveryInput,
): Promise<{ decision: RecoveryDecision; problems: string[] }> {
  const tail = (input.failure.log ?? "").slice(-MAX_LOG_CHARS);
  const blocking = (input.failure.review?.findings ?? [])
    .filter((f) => f.severity === "blocker" || f.severity === "major");

  const { value } = await llm.generateStructured(
    [{
      role: "user",
      content: [
        `# Run goal`,
        input.goal,
        "",
        `# Failed task: ${input.task.id} — ${input.task.title}`,
        `Role: ${input.task.role}`,
        `Attempts so far: ${input.failure.attempts}`,
        `Ended because: ${input.failure.incomplete ? "the worker hit its request limit" : "the worker or its review reported failure"}`,
        "",
        "## Its instruction was",
        input.task.instruction,
        "",
        input.task.acceptance.length
          ? `## Acceptance criteria\n${input.task.acceptance.map((a) => `- ${a}`).join("\n")}`
          : "",
        "",
        `## What the worker reported`,
        input.failure.summary,
        input.failure.error ? `\n## Error\n${input.failure.error}` : "",
        blocking.length
          ? `\n## Reviewer blocked it on\n${blocking.map((f) => `- ${f.file ? f.file + ": " : ""}${f.issue}`).join("\n")}`
          : "",
        tail ? `\n## Tail of the worker log\n\`\`\`\n${tail}\n\`\`\`` : "",
        "",
        `## Other live tasks: ${input.existingIds.join(", ") || "(none)"}`,
        `## Tasks waiting on this one: ${input.dependants.join(", ") || "(none)"}`,
        "",
        "## Shared contract",
        input.contract,
        "",
        "Decide now.",
      ].filter(Boolean).join("\n"),
    }],
    RecoveryDecisionSchema,
    { tier: "planning", system: REDISTRIBUTOR_SYSTEM, temperature: 0.2, maxOutputTokens: 8192 },
  );

  const problems = validateRecovery(value, input.task.id, new Set(input.existingIds))
    .map((p) => p.detail);

  // A structurally broken plan must not reach the scheduler. Degrade to the
  // safe strategy rather than splicing corrupt tasks into the graph.
  if (problems.length > 0) {
    return {
      decision: {
        strategy: "abandon",
        reasoning: `master proposed an unusable ${value.strategy}: ${problems.join("; ")}`,
        replacementTasks: [],
        dependantsCanProceed: false,
      },
      problems,
    };
  }

  return { decision: value, problems: [] };
}
