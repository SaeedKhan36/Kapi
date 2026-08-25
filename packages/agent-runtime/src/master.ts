import {
  TaskGraphSchema, validateTaskGraph, type TaskGraph, type GraphProblem,
} from "@kapi/protocol";
import type { LLMProvider, LlmMessage } from "@kapi/llm";
import type { SandboxProvider } from "@kapi/sandbox";
import { buildRepoDigest, renderDigest, type RepoDigest } from "./repo-context.ts";

const PLANNER_SYSTEM = `You are the Master Agent of an autonomous software engineering team - the CTO of a small group of specialist engineers.

You do NOT write code. You decompose a goal into tasks that independent Worker Agents execute in parallel, each in its own isolated sandbox on its own git branch.

Produce JSON matching this shape:
{
  "goal": "restatement of the objective",
  "contract": {
    "summary": "how the pieces fit together",
    "endpoints": [{ "method": "GET", "path": "/api/x", "description": "...", "requestShape": "...", "responseShape": "..." }],
    "tables": [{ "name": "users", "columns": [{ "name": "id", "type": "uuid", "notes": "pk" }] }],
    "conventions": ["error responses are {error: string}", "..."]
  },
  "tasks": [
    {
      "id": "kebab-case-slug",
      "title": "short imperative title",
      "instruction": "COMPLETE self-contained instructions for one engineer",
      "role": "frontend" | "backend" | "database" | "testing" | "infra" | "docs" | "generalist",
      "dependsOn": ["other-task-id"],
      "touches": ["src/likely/file.ts"],
      "acceptance": ["observable condition that proves the task is done"]
    }
  ]
}

RULES THAT MATTER MOST:

1. THE CONTRACT PREVENTS DEADLOCK. Workers run concurrently and cannot see each
   other's code. Decide every shared interface UP FRONT - API routes, payload
   shapes, table columns, naming conventions - and put it in "contract". A
   frontend worker must be able to build against the contract without waiting to
   ask the backend worker anything.

2. EACH INSTRUCTION IS SELF-CONTAINED. The worker sees the repo, the contract,
   and its own instruction - nothing else. No "as discussed above", no
   references to other tasks' internals. Name exact files and exact behaviour.

3. PARALLELISE HONESTLY. Use "dependsOn" only for genuine ordering constraints
   (code that cannot compile until another task lands). Do not serialise work
   that could run side by side. Tasks touching the same files SHOULD be
   sequenced - flag that via dependsOn.

4. NO CYCLES. The dependency graph must be acyclic, and every dependsOn entry
   must reference an id that exists in this response.

5. RIGHT-SIZE. Between 2 and 8 tasks. Each should be a focused, reviewable
   change - roughly one pull request's worth of work. Prefer fewer, coherent
   tasks over many trivial ones.`;

export type PlanInput = {
  goal: string;
  digest: RepoDigest;
  maxTasks?: number;
};

export type PlanResult = {
  graph: TaskGraph;
  attempts: number;
  repairs: GraphProblem[][];
};

/**
 * Turns a goal plus a repo digest into a validated task DAG.
 *
 * Two validation layers, because they catch different failures:
 *   - Zod checks shape (the LLM invented a field, or used an illegal id).
 *   - validateTaskGraph checks semantics (cycles, dangling deps, duplicates),
 *     which Zod structurally cannot see.
 * Structural problems are fed back for repair rather than failing the run.
 */
export async function planTasks(
  llm: LLMProvider,
  input: PlanInput,
  opts: { maxStructuralRepairs?: number } = {},
): Promise<PlanResult> {
  const maxRepairs = opts.maxStructuralRepairs ?? 2;
  const repairs: GraphProblem[][] = [];

  const messages: LlmMessage[] = [
    {
      role: "user",
      content: [
        `# Goal`,
        input.goal,
        "",
        renderDigest(input.digest),
        "",
        `Produce the plan now.${input.maxTasks ? ` Use at most ${input.maxTasks} tasks.` : ""}`,
      ].join("\n"),
    },
  ];

  for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
    const { value: graph } = await llm.generateStructured(messages, TaskGraphSchema, {
      tier: "planning",
      system: PLANNER_SYSTEM,
      temperature: 0.3,
      maxOutputTokens: 16_384,
    });

    const problems = validateTaskGraph(graph);
    if (problems.length === 0) return { graph, attempts: attempt, repairs };

    repairs.push(problems);
    messages.push({ role: "assistant", content: JSON.stringify(graph) });
    messages.push({
      role: "user",
      content: [
        "That plan is structurally invalid:",
        ...problems.map((p) => `- [${p.kind}] ${p.detail}`),
        "",
        "Return a corrected plan. Keep the tasks that were fine; only fix the dependency problems.",
      ].join("\n"),
    });
  }

  throw new Error(
    `master could not produce an acyclic, well-formed plan after ${maxRepairs + 1} attempts. ` +
      `Last problems: ${JSON.stringify(repairs.at(-1))}`,
  );
}

/** Convenience: clone-aware planning straight from a sandbox. */
export async function planFromSandbox(
  llm: LLMProvider,
  provider: SandboxProvider,
  sandboxId: string,
  goal: string,
  opts: { cwd?: string; maxTasks?: number } = {},
): Promise<PlanResult & { digest: RepoDigest }> {
  const digest = await buildRepoDigest(provider, sandboxId, { cwd: opts.cwd });
  const result = await planTasks(llm, { goal, digest, maxTasks: opts.maxTasks });
  return { ...result, digest };
}
