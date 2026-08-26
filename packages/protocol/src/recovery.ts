import { z } from "zod";
import { PlannedTaskSchema, type PlannedTask, type TaskGraph } from "./plan.ts";

/**
 * What the master decides to do about a failed task.
 *
 * - retry:   the failure looked transient or the worker misunderstood. Run the
 *            same task again with extra guidance.
 * - rescope: the task itself was wrong — too large, badly framed, or resting on
 *            a false assumption. Replace it with different tasks.
 * - abandon: the task cannot be made to work in this run. Dependants are
 *            blocked unless the master says they can proceed without it.
 */
export const RecoveryStrategySchema = z.enum(["retry", "rescope", "abandon"]);
export type RecoveryStrategy = z.infer<typeof RecoveryStrategySchema>;

export const RecoveryDecisionSchema = z.object({
  strategy: RecoveryStrategySchema,
  /** Why this strategy, referring to the actual failure. */
  reasoning: z.string().min(3),
  /** retry: concrete extra instruction. Required, or the retry repeats verbatim. */
  guidance: z.string().optional(),
  /** rescope: tasks that replace the failed one. */
  replacementTasks: z.array(PlannedTaskSchema).default([]),
  /**
   * abandon: whether dependants can still run. True when the failed task was
   * incidental to them; false when their work would be meaningless without it.
   */
  dependantsCanProceed: z.boolean().default(false),
});
export type RecoveryDecision = z.infer<typeof RecoveryDecisionSchema>;

export type RecoveryProblem = { detail: string };

/**
 * Validates a decision against the graph it will be spliced into.
 *
 * A model asked to invent replacement tasks will happily produce ids that
 * collide with live tasks, dependencies on things that never existed, or a
 * "rescope" carrying no replacements at all — each of which corrupts the
 * scheduler rather than failing loudly.
 */
export function validateRecovery(
  decision: RecoveryDecision,
  failedTaskId: string,
  existingIds: ReadonlySet<string>,
): RecoveryProblem[] {
  const problems: RecoveryProblem[] = [];

  if (decision.strategy === "retry" && !decision.guidance?.trim()) {
    problems.push({ detail: "retry needs guidance, or the worker just repeats what already failed" });
  }

  if (decision.strategy === "rescope") {
    if (decision.replacementTasks.length === 0) {
      problems.push({ detail: "rescope needs at least one replacement task" });
    }
    if (decision.replacementTasks.length > 4) {
      problems.push({ detail: "rescope produced more than 4 replacement tasks; keep the graph small" });
    }

    const newIds = new Set<string>();
    for (const task of decision.replacementTasks) {
      if (task.id === failedTaskId) {
        problems.push({ detail: `replacement "${task.id}" reuses the failed task's id` });
      }
      if (existingIds.has(task.id)) {
        problems.push({ detail: `replacement "${task.id}" collides with an existing task` });
      }
      if (newIds.has(task.id)) {
        problems.push({ detail: `replacement "${task.id}" appears twice` });
      }
      newIds.add(task.id);
    }

    for (const task of decision.replacementTasks) {
      for (const dep of task.dependsOn) {
        // A replacement may depend on live tasks or its siblings, never on the
        // task it is replacing.
        if (dep === failedTaskId) {
          problems.push({ detail: `replacement "${task.id}" depends on the failed task it replaces` });
        } else if (!existingIds.has(dep) && !newIds.has(dep)) {
          problems.push({ detail: `replacement "${task.id}" depends on unknown task "${dep}"` });
        }
      }
    }
  }

  return problems;
}

/**
 * Rewrites dependencies so tasks waiting on a rescoped task wait on its
 * replacements instead. Without this the dependants block forever on an id that
 * no longer runs.
 */
export function remapDependencies(
  tasks: PlannedTask[],
  replacedId: string,
  replacementIds: string[],
): PlannedTask[] {
  return tasks.map((task) => {
    if (!task.dependsOn.includes(replacedId)) return task;
    const rest = task.dependsOn.filter((d) => d !== replacedId);
    return { ...task, dependsOn: [...new Set([...rest, ...replacementIds])] };
  });
}

/** Applies a validated decision to a graph, returning the updated task list. */
export function applyRecovery(
  graph: TaskGraph,
  failedTaskId: string,
  decision: RecoveryDecision,
): PlannedTask[] {
  if (decision.strategy !== "rescope") return graph.tasks;

  const replacementIds = decision.replacementTasks.map((t) => t.id);
  const withoutFailed = graph.tasks.filter((t) => t.id !== failedTaskId);
  const remapped = remapDependencies(withoutFailed, failedTaskId, replacementIds);
  return [...remapped, ...decision.replacementTasks];
}
