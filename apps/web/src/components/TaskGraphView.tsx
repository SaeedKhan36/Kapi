import type { Task } from "~/lib/types.ts";
import { cn } from "~/lib/cn.ts";
import { Badge, Card, EmptyState, RoleChip } from "./ui.tsx";

/**
 * Renders the DAG as dependency levels rather than a free-form node graph:
 * "what can run in parallel right now" is the question this view exists to
 * answer, and levels show it directly.
 */
function toLevels(tasks: Task[]): Task[][] {
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  const depth = new Map<string, number>();

  const resolve = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;              // defensive: cycles are rejected upstream
    seen.add(id);
    const task = byId.get(id);
    const d = !task || task.dependsOn.length === 0
      ? 0
      : 1 + Math.max(...task.dependsOn.map((p) => resolve(p, seen)));
    depth.set(id, d);
    return d;
  };

  for (const t of tasks) resolve(t.taskId);

  const levels: Task[][] = [];
  for (const t of tasks) {
    const d = depth.get(t.taskId) ?? 0;
    (levels[d] ??= []).push(t);
  }
  return levels.filter(Boolean);
}

const BORDER: Record<string, string> = {
  running: "bg-[#e0f2fe]",
  assigned: "bg-[#e0f2fe]",
  planning: "bg-[#ede9fe]",
  failed: "bg-[#fecaca]",
  blocked: "bg-[#fef08a]",
  completed: "bg-[#dcfce7]",
  review: "bg-[#dcfce7]",
  merged: "bg-[#dcfce7]",
};

export function TaskGraphView({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) {
    return (
      <EmptyState
        title="Waiting for the plan"
        hint="The master is reading the repository and drafting the task graph."
      />
    );
  }

  const levels = toLevels(tasks);

  return (
    <div className="space-y-5">
      {levels.map((level, i) => (
        <div key={i}>
          <div className="mb-2 flex items-center gap-2.5">
            <span className="grid size-5 place-items-center rounded-full border-[1.5px] border-line bg-[#bae6fd] font-mono text-[10px] font-semibold text-bright">
              {i + 1}
            </span>
            <span className="text-[11px] uppercase tracking-widest text-dim">
              {level.length > 1 ? `${level.length} in parallel` : "single task"}
            </span>
            <div className="h-px flex-1 bg-line/30" />
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {level.map((task) => (
              <Card
                key={task.taskId}
                className={cn(
                  "p-3.5 transition-colors",
                  BORDER[task.status] ?? "bg-white",
                  task.status === "pending" && "opacity-70",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 text-sm font-medium leading-snug text-bright">{task.title}</p>
                  <Badge status={task.status} />
                </div>

                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <RoleChip role={task.role} />
                  <span className="font-mono text-[10px] text-dim">{task.taskId}</span>
                  {task.dependsOn.map((d) => (
                    <span
                      key={d}
                      className="rounded border border-line/50 px-1.5 py-0.5 font-mono text-[10px] text-dim"
                    >
                      ← {d}
                    </span>
                  ))}
                </div>

                {task.attempts > 1 && (
                  <p className="mt-2 text-[11px] text-warn">
                    attempt {task.attempts} — re-dispatched by the master
                  </p>
                )}
                {task.branch && (
                  <p className="mt-2 truncate font-mono text-[10px] text-dim">{task.branch}</p>
                )}
                {task.error && (
                  <p className="mt-2 line-clamp-2 text-[11px] text-bad">{task.error}</p>
                )}
              </Card>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
