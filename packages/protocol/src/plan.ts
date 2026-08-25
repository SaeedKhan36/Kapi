import { z } from "zod";
import { AgentRoleSchema } from "./ids.ts";

/**
 * The Shared Contract is the deadlock guard.
 *
 * The master publishes it BEFORE any worker starts, so the frontend worker
 * never has to block waiting on the backend worker to invent an API shape.
 * Workers consult the contract first and only send QUERY when it is genuinely
 * insufficient.
 */
export const ApiEndpointSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string(),
  description: z.string(),
  requestShape: z.string().optional(),
  responseShape: z.string().optional(),
});

export const DbTableSchema = z.object({
  name: z.string(),
  columns: z.array(z.object({ name: z.string(), type: z.string(), notes: z.string().optional() })),
});

export const SharedContractSchema = z.object({
  summary: z.string(),
  endpoints: z.array(ApiEndpointSchema).default([]),
  tables: z.array(DbTableSchema).default([]),
  /** Free-form conventions every worker must honour (naming, error format, auth header...). */
  conventions: z.array(z.string()).default([]),
});
export type SharedContract = z.infer<typeof SharedContractSchema>;

export const PlannedTaskSchema = z.object({
  /** Stable, human-readable id the LLM assigns, e.g. "backend-health-endpoint". */
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,60}$/, "task id must be a lowercase slug"),
  title: z.string().min(3),
  /** The full instruction handed to the coding engine. Must be self-contained. */
  instruction: z.string().min(10),
  role: AgentRoleSchema,
  dependsOn: z.array(z.string()).default([]),
  /** Files the planner expects to be touched. Advisory - used for conflict prediction. */
  touches: z.array(z.string()).default([]),
  acceptance: z.array(z.string()).default([]),
});
export type PlannedTask = z.infer<typeof PlannedTaskSchema>;

export const TaskGraphSchema = z.object({
  goal: z.string(),
  contract: SharedContractSchema,
  tasks: z.array(PlannedTaskSchema).min(1),
});
export type TaskGraph = z.infer<typeof TaskGraphSchema>;

export type GraphProblem = { kind: "unknown-dep" | "cycle" | "duplicate-id"; detail: string };

/**
 * Structural validation the LLM cannot be trusted to get right on its own:
 * duplicate ids, dangling `dependsOn` references, and dependency cycles.
 * Returns every problem found so the master can repair in a single retry.
 */
export function validateTaskGraph(graph: TaskGraph): GraphProblem[] {
  const problems: GraphProblem[] = [];
  const ids = new Set<string>();

  for (const task of graph.tasks) {
    if (ids.has(task.id)) {
      problems.push({ kind: "duplicate-id", detail: `task id "${task.id}" appears more than once` });
    }
    ids.add(task.id);
  }

  for (const task of graph.tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        problems.push({
          kind: "unknown-dep",
          detail: `task "${task.id}" depends on "${dep}", which does not exist`,
        });
      }
    }
  }

  // Iterative DFS with a colour map: white = unvisited, grey = on stack, black = done.
  const colour = new Map<string, "grey" | "black">();
  const byId = new Map(graph.tasks.map((t) => [t.id, t]));

  const visit = (start: string) => {
    const stack: Array<{ id: string; path: string[] }> = [{ id: start, path: [] }];
    while (stack.length > 0) {
      const { id, path } = stack.pop()!;
      const state = colour.get(id);
      if (state === "black") continue;
      if (state === "grey") {
        colour.set(id, "black");
        continue;
      }
      colour.set(id, "grey");
      // Re-push self as a marker so we can blacken it after its children.
      stack.push({ id, path });
      for (const dep of byId.get(id)?.dependsOn ?? []) {
        if (colour.get(dep) === "grey") {
          problems.push({
            kind: "cycle",
            detail: `dependency cycle: ${[...path, id, dep].join(" -> ")}`,
          });
          continue;
        }
        if (colour.get(dep) !== "black") stack.push({ id: dep, path: [...path, id] });
      }
    }
  };

  for (const task of graph.tasks) if (!colour.has(task.id)) visit(task.id);

  return problems;
}

/** Tasks whose dependencies are all satisfied, given a set of completed task ids. */
export function readyTasks(graph: TaskGraph, completed: ReadonlySet<string>): PlannedTask[] {
  return graph.tasks.filter(
    (t) => !completed.has(t.id) && t.dependsOn.every((d) => completed.has(d)),
  );
}
