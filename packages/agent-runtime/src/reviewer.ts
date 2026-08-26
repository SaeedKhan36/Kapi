import {
  ReviewVerdictSchema, normaliseVerdict, type PlannedTask, type ReviewVerdict,
} from "@kapi/protocol";
import type { LLMProvider } from "@kapi/llm";
import type { SandboxProvider } from "@kapi/sandbox";
import { shellQuote } from "@kapi/sandbox";

const REVIEWER_SYSTEM = `You are the Review Agent. You read a diff produced by another engineer and decide whether it can be merged.

Respond with JSON:
{
  "decision": "approve" | "request_changes",
  "summary": "one or two sentences on the state of this change",
  "findings": [
    { "severity": "blocker"|"major"|"minor"|"nit", "file": "src/x.ts",
      "issue": "what is wrong", "suggestion": "how to fix it" }
  ],
  "acceptanceMet": [true, false]
}

SEVERITY — be strict about what blocks:
- "blocker": the change is broken or does not do what the task asked. Code that
  cannot run, a missing file the task required, an unmet acceptance criterion,
  a violation of the shared contract, a secret committed, data loss.
- "major": a real defect that will bite — wrong logic on a realistic input,
  an unhandled error path that will occur, a security hole.
- "minor": genuine improvement, safe to merge without.
- "nit": style or taste.

Only "blocker" and "major" stop the merge. Everything else is advice.

RULES:
- Judge ONLY the diff and the task it was meant to satisfy. Do not demand work
  that belongs to another task, and do not review code that was already there.
- Every blocker and major MUST have a concrete "suggestion". A worker has to act
  on it without asking you anything.
- State findings as defects with a mechanism ("X throws when Y is empty"), not
  preferences ("prefer Z").
- "acceptanceMet" has one boolean per acceptance criterion, in the order given.
- An unfinished-but-correct change is still approvable if it meets the task.
- Do NOT invent problems. If the diff does what the task asked and works,
  approve it. Approving good work is the correct outcome, not a failure.`;

export type ReviewInput = {
  task: PlannedTask;
  contract: string;
  diff: string;
  filesChanged: string[];
  /** What the worker said it did, so the reviewer can check the claim. */
  workerSummary: string;
};

const MAX_DIFF_CHARS = 60_000;

/** Reads the branch's diff against its merge base. */
export async function collectDiff(
  provider: SandboxProvider,
  sandboxId: string,
  opts: { base: string; branch: string; cwd?: string },
): Promise<{ diff: string; files: string[]; truncated: boolean }> {
  const cwd = opts.cwd ?? "repo";
  const range = `${shellQuote(`origin/${opts.base}`)}...${shellQuote(opts.branch)}`;

  const names = await provider.exec(sandboxId, `git diff --name-only ${range}`, { cwd });
  const files = names.stdout.split("\n").map((l) => l.trim()).filter(Boolean);

  // Lockfiles are enormous and carry no review signal.
  const excludes = [":(exclude)*lock*", ":(exclude)*.lock", ":(exclude)*.min.*"]
    .map(shellQuote).join(" ");
  const body = await provider.exec(
    sandboxId,
    `git diff ${range} -- . ${excludes}`,
    { cwd, timeoutMs: 60_000 },
  );

  const raw = body.stdout;
  const truncated = raw.length > MAX_DIFF_CHARS;
  return {
    diff: truncated ? raw.slice(0, MAX_DIFF_CHARS) + "\n... [diff truncated]" : raw,
    files,
    truncated,
  };
}

/**
 * Judges one worker's branch.
 *
 * Costs exactly one LLM request per review, which matters on a free tier capped
 * at 20 requests per model per day.
 */
export async function reviewChange(
  llm: LLMProvider,
  input: ReviewInput,
): Promise<ReviewVerdict> {
  if (!input.diff.trim()) {
    return {
      decision: "request_changes",
      summary: "The branch contains no changes, so the task was not carried out.",
      findings: [{
        severity: "blocker",
        issue: `No file changes were produced for "${input.task.title}".`,
        suggestion: "Implement the task and commit the result.",
      }],
      acceptanceMet: input.task.acceptance.map(() => false),
    };
  }

  const { value } = await llm.generateStructured(
    [{
      role: "user",
      content: [
        `# Task under review: ${input.task.title}`,
        "",
        input.task.instruction,
        "",
        input.task.acceptance.length
          ? `## Acceptance criteria (return one boolean each, in order)\n${
              input.task.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")}`
          : "## Acceptance criteria\n(none stated)",
        "",
        "## Shared contract the change must honour",
        input.contract,
        "",
        `## What the engineer reported`,
        input.workerSummary,
        "",
        `## Files changed (${input.filesChanged.length})`,
        input.filesChanged.map((f) => `- ${f}`).join("\n"),
        "",
        "## Diff",
        "```diff",
        input.diff,
        "```",
        "",
        "Review it now.",
      ].join("\n"),
    }],
    ReviewVerdictSchema,
    { tier: "coding", system: REVIEWER_SYSTEM, temperature: 0.1, maxOutputTokens: 8192 },
  );

  return normaliseVerdict(value);
}
