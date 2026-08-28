import { useEffect, useState } from "react";
import { cn } from "~/lib/cn.ts";
import { Badge, RoleChip } from "../ui.tsx";

/**
 * The hero's proof, rather than another paragraph.
 *
 * A landing page that describes parallel agents in prose asks the reader to
 * imagine the product; a small live replay of a real run shows it. The data is
 * a fixed script - honest about shape, not pretending to be a live session.
 */
const TASKS = [
  { wave: 1, role: "database", title: "orders + line_items schema", at: 1 },
  { wave: 1, role: "backend", title: "POST /api/checkout", at: 1 },
  { wave: 2, role: "frontend", title: "Checkout page + card form", at: 3 },
  { wave: 2, role: "testing", title: "End-to-end purchase flow", at: 4 },
] as const;

const FEED = [
  // Addressed as the engine addresses them: these land as broadcasts on the
  // run's bus, not as a private line from one worker to another.
  { at: 2, from: "database", to: "broadcast", type: "SCHEMA_READY", text: "orders(id, total_cents, status)" },
  { at: 3, from: "backend", to: "broadcast", type: "API_READY", text: "POST /api/checkout → { url }" },
  { at: 5, from: "testing", to: "master", type: "TASK_COMPLETED", text: "4 specs pass on kapi/testing" },
] as const;

const STEPS = 6;

/** pending → running → review, driven by how far the replay has advanced. */
function statusFor(startsAt: number, step: number) {
  if (step < startsAt) return "pending";
  if (step < startsAt + 2) return "running";
  return "review";
}

export function RunPreview() {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStep(STEPS);
      return;
    }
    const timer = setInterval(() => setStep((s) => (s + 1) % (STEPS + 3)), 1100);
    return () => clearInterval(timer);
  }, []);

  const waves = [1, 2] as const;

  return (
    <div className="relative">
      {/* The glow belongs to the card, not the page, so it moves with it. */}
      <div
        aria-hidden
        className="absolute -inset-8 -z-10 rounded-full bg-accent/10 blur-3xl"
      />
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-line/70 bg-surface/80 shadow-2xl shadow-black/40 backdrop-blur">
        <header className="flex items-center gap-2 border-b border-line/50 bg-well/50 px-4 py-2.5">
          <span className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-bad/60" />
            <span className="size-2.5 rounded-full bg-warn/60" />
            <span className="size-2.5 rounded-full bg-ok/60" />
          </span>
          <span className="ml-2 font-mono text-[11px] text-dim">run_8fc21a</span>
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-ok">
            <span className="size-1.5 animate-pulse rounded-full bg-ok" /> live
          </span>
        </header>

        <div className="space-y-4 p-4">
          <p className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 font-mono text-xs text-accent">goal</span>
            <span className="text-bright">Add Stripe checkout with a persisted order history</span>
          </p>

          {waves.map((wave) => (
            <div key={wave}>
              <div className="mb-2 flex items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-widest text-dim">
                  wave {wave}
                </span>
                <div className="h-px flex-1 bg-line/40" />
                <span className="text-[10px] text-dim">2 in parallel</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {TASKS.filter((t) => t.wave === wave).map((task) => {
                  const status = statusFor(task.at, step);
                  return (
                    <div
                      key={task.title}
                      className={cn(
                        "rounded-lg border bg-well/40 p-2.5 transition-colors duration-500",
                        status === "running" ? "border-accent/50" : "border-line/50",
                        status === "pending" && "opacity-50",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <RoleChip role={task.role} />
                        <Badge status={status} />
                      </div>
                      <p className="mt-1.5 truncate text-xs text-muted">{task.title}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Sized to what has arrived, with a floor so the card never jumps
              between an empty feed and a full one. */}
          <div className="min-h-24 space-y-1.5 rounded-lg border border-line/50 bg-well/50 p-3">
            {FEED.filter((msg) => step >= msg.at).map((msg) => (
              <div key={msg.type} className="animate-in font-mono text-[11px]">
                <span className="text-muted">{msg.from}</span>
                <span className="text-dim"> → </span>
                <span className="text-muted">{msg.to}</span>
                <span className="ml-2 text-ok">{msg.type}</span>
                <p className="text-dim">{msg.text}</p>
              </div>
            ))}
            {step < FEED[0].at && (
              <p className="font-mono text-[11px] text-dim">
                master · reading the repository<span className="animate-pulse">…</span>
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
