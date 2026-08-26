import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "~/lib/api.ts";
import { compact, shortRepo } from "~/lib/format.ts";
import { useRunStream } from "~/lib/useRunStream.ts";
import type { Message, RunDetail, RunEvent, Task } from "~/lib/types.ts";
import { AppShell } from "~/components/AppShell.tsx";
import { MessageFeed } from "~/components/MessageFeed.tsx";
import { TaskGraphView } from "~/components/TaskGraphView.tsx";
import {
  Badge, Card, Dot, EmptyState, Notice, RoleChip, Spinner, Stat, Tabs,
} from "~/components/ui.tsx";

export const Route = createFileRoute("/app/runs/$runId")({ component: RunView });

const DONE = new Set(["review", "merged", "completed"]);

type Pane = "graph" | "contract" | "agents";

function RunView() {
  const { runId } = Route.useParams();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [taskStatus, setTaskStatus] = useState<Record<string, string>>({});
  const [runStatus, setRunStatus] = useState<string>("");
  const [pane, setPane] = useState<Pane>("graph");
  const [loadError, setLoadError] = useState<string | null>(null);
  const seen = useRef(new Set<string>());

  const load = useCallback(async () => {
    const d = await api.getRun(runId);
    setDetail(d);
    setRunStatus(d.run.status);
    setMessages(d.messages);
    d.messages.forEach((m) => seen.current.add(m.id));
    setTaskStatus(Object.fromEntries(d.tasks.map((t) => [t.taskId, t.status])));
  }, [runId]);

  useEffect(() => {
    load().catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, [load]);

  const onEvent = useCallback((e: RunEvent) => {
    switch (e.kind) {
      case "message":
        if (seen.current.has(e.message.id)) return;
        seen.current.add(e.message.id);
        setMessages((prev) => [...prev, e.message]);
        break;
      case "task":
        setTaskStatus((prev) => ({ ...prev, [e.taskId]: e.status }));
        break;
      case "status":
        setRunStatus(e.status);
        // A finished run has final artifacts and branches worth re-reading.
        if (e.status !== "planning") load().catch(() => {});
        break;
      case "plan":
        load().catch(() => {});
        break;
    }
  }, [load]);

  const connected = useRunStream(runId, onEvent);

  const tasks: Task[] = useMemo(
    () => (detail?.tasks ?? []).map((t) => ({ ...t, status: taskStatus[t.taskId] ?? t.status })),
    [detail, taskStatus],
  );

  if (!detail) {
    return (
      <AppShell back={{ to: "/app", label: "Runs" }}>
        {loadError ? (
          <div className="py-8">
            <Notice tone="bad">{loadError}</Notice>
          </div>
        ) : (
          <div className="flex items-center gap-2 py-16 text-sm text-dim"><Spinner /> Loading run…</div>
        )}
      </AppShell>
    );
  }

  const { run } = detail;
  const contract = run.plan?.contract;
  const done = tasks.filter((t) => DONE.has(t.status)).length;
  const status = runStatus || run.status;

  return (
    <AppShell back={{ to: "/app", label: "Runs" }}>
      <div className="space-y-6">
        <RunHeader
          goal={run.goal}
          status={status}
          repo={shortRepo(run.repoUrl)}
          provider={run.sandboxProvider}
          connected={connected}
          done={done}
          total={tasks.length}
          llmRequests={run.llmRequests}
          llmTokens={run.llmTokens}
        />

        {run.error && <Notice tone="bad">{run.error}</Notice>}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div>
            <Tabs
              value={pane}
              onChange={setPane}
              tabs={[
                { id: "graph", label: "Task graph", count: tasks.length },
                { id: "contract", label: "Contract" },
                { id: "agents", label: "Agents", count: detail.agents.length },
              ]}
            />

            <div className="mt-4">
              {pane === "graph" && <TaskGraphView tasks={tasks} />}

              {pane === "contract" && (contract ? (
                <Card className="space-y-5 p-5 text-sm">
                  <p className="leading-relaxed text-muted">{contract.summary}</p>

                  {contract.endpoints.length > 0 && (
                    <Block label="Endpoints">
                      {contract.endpoints.map((e) => (
                        <div key={`${e.method}${e.path}`} className="font-mono text-xs">
                          <span className="text-accent">{e.method}</span>{" "}
                          <span className="text-bright">{e.path}</span>
                          <span className="text-dim"> — {e.description}</span>
                        </div>
                      ))}
                    </Block>
                  )}

                  {contract.tables.length > 0 && (
                    <Block label="Tables">
                      {contract.tables.map((t) => (
                        <div key={t.name} className="font-mono text-xs">
                          <span className="text-warn">{t.name}</span>
                          <span className="text-dim">
                            ({t.columns.map((c) => `${c.name}: ${c.type}`).join(", ")})
                          </span>
                        </div>
                      ))}
                    </Block>
                  )}

                  {contract.conventions.length > 0 && (
                    <Block label="Conventions">
                      <ul className="space-y-1 text-xs text-muted">
                        {contract.conventions.map((c) => (
                          <li key={c} className="flex gap-2">
                            <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-line" />
                            {c}
                          </li>
                        ))}
                      </ul>
                    </Block>
                  )}
                </Card>
              ) : (
                <EmptyState title="No contract yet" hint="The master publishes one with the plan." />
              ))}

              {pane === "agents" && (
                <div className="grid gap-2 sm:grid-cols-2">
                  {detail.agents.map((a) => (
                    <Card key={a.agentId} className="flex items-center justify-between gap-2 p-3.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <RoleChip role={a.role} />
                        <span className="truncate font-mono text-[11px] text-dim">{a.agentId}</span>
                      </div>
                      <Badge status={a.status} />
                    </Card>
                  ))}
                  {detail.agents.length === 0 && (
                    <div className="sm:col-span-2">
                      <EmptyState title="No agents started yet" />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <section className="lg:sticky lg:top-24 lg:self-start">
            <MessageFeed messages={messages} />
          </section>
        </div>
      </div>
    </AppShell>
  );
}

function RunHeader(props: {
  goal: string; status: string; repo: string; provider: string; connected: boolean;
  done: number; total: number; llmRequests: number; llmTokens: number;
}) {
  const pct = props.total > 0 ? Math.round((props.done / props.total) * 100) : 0;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-4 p-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-lg font-semibold leading-snug tracking-tight">{props.goal}</h1>
            <Badge status={props.status} />
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-dim">
            <span>{props.repo}</span>
            <span aria-hidden>·</span>
            <span>{props.provider} sandbox</span>
          </p>
        </div>

        <div className="flex items-center gap-6">
          <Stat label="tasks" value={props.total > 0 ? `${props.done}/${props.total}` : "—"} />
          <Stat label="llm calls" value={compact(props.llmRequests)} />
          <Stat label="tokens" value={compact(props.llmTokens)} />
          <span className="flex items-center gap-2 text-[11px] text-dim">
            <Dot on={props.connected} />
            {props.connected ? "live" : "reconnecting"}
          </span>
        </div>
      </div>

      {/* Progress as a rule under the header rather than another number. */}
      <div className="h-0.5 w-full bg-line/40">
        <div
          className="h-full bg-accent transition-[width] duration-700 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </Card>
  );
}

const Block = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <p className="mb-2 text-[11px] uppercase tracking-widest text-dim">{label}</p>
    <div className="space-y-1">{children}</div>
  </div>
);
