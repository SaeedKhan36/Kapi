import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronDown, Inbox, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError, type Health, type Me } from "~/lib/api.ts";
import { cn } from "~/lib/cn.ts";
import { compact, timeAgo } from "~/lib/format.ts";
import type { Run } from "~/lib/types.ts";
import { AppShell } from "~/components/AppShell.tsx";
import { RepoPicker, type RepoSelection } from "~/components/RepoPicker.tsx";
import {
  Badge, Button, Card, EmptyState, Field, Input, Notice, Section, Spinner, Textarea,
} from "~/components/ui.tsx";

export const Route = createFileRoute("/app/")({ component: Dashboard });

function Dashboard() {
  const navigate = useNavigate();
  const [goal, setGoal] = useState("");
  const [repo, setRepo] = useState<RepoSelection>({ repoUrl: "", baseBranch: "main" });
  const [maxTasks, setMaxTasks] = useState(4);
  const [concurrency, setConcurrency] = useState(3);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  useEffect(() => {
    api.listRuns().then(setRuns).catch(() => setRuns([]));
    api.health().then(setHealth).catch(() => setHealth(null));
    api.me().then(setMe).catch(() => setMe(null));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { runId } = await api.createRun({
        goal,
        repoUrl: repo.repoUrl,
        baseBranch: repo.baseBranch,
        maxTasks,
        maxConcurrency: concurrency,
      });
      navigate({ to: "/app/runs/$runId", params: { runId } });
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <section>
          <h1 className="font-display text-3xl font-bold tracking-tight">Start a run</h1>
          <p className="mt-1.5 text-sm text-muted">
            One goal. The master plans it, the workers build it in parallel.
          </p>

          <Card className="mt-6 bg-[#fffdf8] p-6">
            <form onSubmit={submit} className="space-y-6">
              <Field label="Repository" hint="cloned, then branched from">
                <RepoPicker value={repo} onChange={setRepo} connectUrl={me?.github.connectUrl} />
              </Field>

              <Field label="Goal" hint="what the team should build">
                <Textarea
                  required
                  rows={5}
                  placeholder="Add a /health endpoint returning JSON status, plus a test covering it"
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                />
              </Field>

              {/* Two knobs most runs never touch. Folded away so the form is
                  two decisions, not four. */}
              <details className="group rounded-2xl border-[1.5px] border-line bg-white">
                <summary className="flex items-center justify-between px-3.5 py-2.5 text-xs font-semibold text-muted transition-colors hover:text-bright">
                  Limits · {maxTasks} tasks · {concurrency} in parallel
                  <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
                </summary>
                <div className="grid grid-cols-2 gap-4 border-t-[1.5px] border-line p-3.5">
                  <Field label="Max tasks" hint="plan size">
                    <Input
                      type="number" min={1} max={12} value={maxTasks}
                      onChange={(e) => setMaxTasks(Number(e.target.value))}
                    />
                  </Field>
                  <Field label="Workers" hint="sandboxes at once">
                    <Input
                      type="number" min={1} max={8} value={concurrency}
                      onChange={(e) => setConcurrency(Number(e.target.value))}
                    />
                  </Field>
                </div>
              </details>

              {error && (
                <Notice tone="bad">
                  <p>{error.message}</p>
                  {/* A refused run usually has a remedy; show it rather than
                      leaving the user with a 403 and nowhere to go. */}
                  {error instanceof ApiError && error.installUrl && (
                    <a
                      href={error.installUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block text-xs font-medium underline"
                    >
                      Install the kapi app on this repository →
                    </a>
                  )}
                </Notice>
              )}

              <Button
                type="submit"
                size="lg"
                disabled={busy || !goal || !repo.repoUrl}
                className="w-full"
              >
                {busy ? <><Spinner /> Starting…</> : <><Sparkles className="size-4" /> Start run</>}
              </Button>
            </form>
          </Card>

          {health && !health.llmConfigured && (
            <div className="mt-4">
              <Notice tone="warn">
                No model key configured. Set <code className="font-mono">GEMINI_API_KEY</code> in{" "}
                <code className="font-mono">.env</code> — free at aistudio.google.com/apikey.
              </Notice>
            </div>
          )}
        </section>

        <Section
          title="Recent runs"
          action={health && (
            <span className="font-mono text-[11px] text-dim">
              {health.provider} · {health.pushEnabled ? "push on" : "push off"}
            </span>
          )}
        >
          {runs === null && (
            <div className="flex items-center gap-2 py-6 text-sm text-dim"><Spinner /> Loading…</div>
          )}

          {runs?.length === 0 && (
            <EmptyState
              icon={<Inbox className="size-5" />}
              title="No runs yet"
              hint="Your first run will appear here, and stay streamable while it works."
            />
          )}

          <div className="space-y-3">
            {runs && [...runs].reverse().map((run, i) => (
              <Link
                key={run.id}
                to="/app/runs/$runId"
                params={{ runId: run.id }}
                className={cn(
                  "block rounded-[var(--radius-card)] border-[1.5px] border-line p-4 shadow-[3px_3px_0_#1c1917] transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-[5px_5px_0_#1c1917]",
                  i % 3 === 0 && "bg-white",
                  i % 3 === 1 && "bg-[#fef9c3]",
                  i % 3 === 2 && "bg-[#e0f2fe]",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="line-clamp-2 text-sm leading-snug text-bright">{run.goal}</p>
                  <Badge status={run.status} />
                </div>
                <p className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-dim">
                  <span>{run.plan?.tasks.length ?? 0} tasks</span>
                  <span aria-hidden>·</span>
                  <span>{compact(run.llmRequests)} calls</span>
                  <span aria-hidden>·</span>
                  <span>{timeAgo(run.createdAt)}</span>
                </p>
              </Link>
            ))}
          </div>
        </Section>
      </div>
    </AppShell>
  );
}
