import { ArrowRight, Boxes, GitBranch, Network } from "lucide-react";
import type { ReactNode } from "react";
import { RoleChip } from "../ui.tsx";

/**
 * The README's ASCII diagram, made responsive.
 *
 * Three stages, one arrow between each: horizontal on a wide screen, vertical
 * on a narrow one. Drawn in HTML rather than SVG so the labels stay at a real
 * font size on a phone instead of scaling down with a viewBox.
 */
const ROLES = ["frontend", "backend", "database", "testing", "infra", "docs"];

export function Architecture() {
  return (
    <div className="grid items-stretch gap-4 lg:grid-cols-[1fr_auto_1fr_auto_1fr]">
      <Stage
        icon={<Network className="size-4" />}
        kicker="one process"
        title="Orchestrator"
      >
        <Line>Walks the DAG, runs every task whose dependencies are done</Line>
        <Line>Message bus, in-process or Redis</Line>
        <Line>Persists every message as it crosses</Line>
      </Stage>

      <Arrow />

      <Stage
        icon={<Boxes className="size-4" />}
        kicker="one sandbox each"
        title="Master + workers"
      >
        <Line>Master reads the repo read-only and emits the task graph</Line>
        <Line>Workers implement in parallel and message each other directly</Line>
        <div className="flex flex-wrap gap-1 pt-1">
          {ROLES.map((role) => <RoleChip key={role} role={role} />)}
        </div>
      </Stage>

      <Arrow />

      <Stage
        icon={<GitBranch className="size-4" />}
        kicker="your repository"
        title="Branches you can read"
      >
        <Line>Real commits on one branch per worker</Line>
        <Line>Pushed with a token scoped to that repository, for an hour</Line>
        <Line>Changed files and summaries come back as artifacts</Line>
      </Stage>
    </div>
  );
}

function Stage({ icon, kicker, title, children }: {
  icon: ReactNode; kicker: string; title: string; children: ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-line/60 bg-surface/50 p-5">
      <div className="flex items-center gap-2 text-accent">
        {icon}
        <span className="text-[11px] uppercase tracking-widest text-dim">{kicker}</span>
      </div>
      <h3 className="mt-2 text-base font-semibold text-bright">{title}</h3>
      <div className="mt-3 space-y-1.5">{children}</div>
    </div>
  );
}

const Line = ({ children }: { children: ReactNode }) => (
  <p className="flex gap-2 text-sm leading-relaxed text-muted">
    <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-line" />
    {children}
  </p>
);

const Arrow = () => (
  <div aria-hidden className="grid place-items-center text-dim">
    <ArrowRight className="size-5 rotate-90 lg:rotate-0" />
  </div>
);
