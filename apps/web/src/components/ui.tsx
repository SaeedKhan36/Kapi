import type {
  ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode,
  SelectHTMLAttributes, TextareaHTMLAttributes,
} from "react";
import { cn } from "~/lib/cn.ts";

/**
 * The whole component vocabulary, in one file.
 *
 * Every surface in kapi is built from these eight or so pieces, which is the
 * point: an agent dashboard is mostly status, and status only reads at a
 * glance if the same state always looks the same.
 */

// ------------------------------------------------------------------ surfaces

export const Card = ({ className, children, ...props }:
  HTMLAttributes<HTMLDivElement> & { children: ReactNode }) => (
  <div
    className={cn(
      "rounded-[var(--radius-card)] border border-line/60 bg-surface/60 backdrop-blur-sm",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

/** A titled block. Keeps every section's heading the same weight and rhythm. */
export const Section = ({ title, action, children, className }: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) => (
  <section className={className}>
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-dim">{title}</h2>
      {action}
    </div>
    {children}
  </section>
);

export const EmptyState = ({ icon, title, hint }: {
  icon?: ReactNode; title: string; hint?: string;
}) => (
  <Card className="grid place-items-center gap-2 px-6 py-12 text-center">
    {icon && <div className="text-dim">{icon}</div>}
    <p className="text-sm font-medium text-muted">{title}</p>
    {hint && <p className="max-w-xs text-xs text-dim">{hint}</p>}
  </Card>
);

// ------------------------------------------------------------------ controls

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
};

const BUTTON_VARIANT = {
  primary: "bg-accent text-accent-ink hover:brightness-110 active:brightness-95 shadow-[0_0_24px_-8px] shadow-accent/60",
  secondary: "border border-line bg-raised/40 text-bright hover:border-accent/60 hover:bg-raised",
  ghost: "text-muted hover:bg-raised/60 hover:text-bright",
} as const;

const BUTTON_SIZE = {
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-12 px-6 text-[0.95rem] gap-2",
} as const;

export const Button = ({ className, variant = "primary", size = "md", ...props }: ButtonProps) => (
  <button
    className={cn(
      "inline-flex cursor-pointer items-center justify-center rounded-lg font-medium",
      "transition-[background-color,border-color,filter,transform] duration-200",
      "disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none disabled:saturate-0",
      BUTTON_VARIANT[variant], BUTTON_SIZE[size], className,
    )}
    {...props}
  />
);

/** The same surface as Button, for links. Anchors cannot be buttons. */
export const buttonClass = (variant: keyof typeof BUTTON_VARIANT = "primary", size: keyof typeof BUTTON_SIZE = "md") =>
  cn(
    "inline-flex cursor-pointer items-center justify-center rounded-lg font-medium transition-all duration-200",
    BUTTON_VARIANT[variant], BUTTON_SIZE[size],
  );

const FIELD_SURFACE =
  "w-full rounded-lg border border-line/80 bg-well/60 px-3 py-2 text-sm text-bright transition-colors " +
  "placeholder:text-dim/70 hover:border-line focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40";

export const Input = ({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) => (
  <input className={cn(FIELD_SURFACE, "h-10", className)} {...props} />
);

export const Textarea = ({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea className={cn(FIELD_SURFACE, "resize-y leading-relaxed", className)} {...props} />
);

export const Select = ({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select className={cn(FIELD_SURFACE, "h-10 cursor-pointer appearance-none pr-8", className)} {...props} />
);

/**
 * Label above, hint beside it, control below.
 *
 * The hint sits next to the label rather than under the input so a form reads
 * as a column of controls, not a wall of prose.
 */
export const Field = ({ label, hint, children }: {
  label: string; hint?: string; children: ReactNode;
}) => (
  <label className="block">
    <span className="flex items-baseline gap-2">
      <span className="text-sm font-medium text-bright">{label}</span>
      {hint && <span className="text-xs text-dim">{hint}</span>}
    </span>
    <div className="mt-2">{children}</div>
  </label>
);

// -------------------------------------------------------------------- status

const STATUS_TONE: Record<string, string> = {
  review: "text-ok border-ok/30 bg-ok/10",
  merged: "text-ok border-ok/30 bg-ok/10",
  completed: "text-ok border-ok/30 bg-ok/10",
  running: "text-accent border-accent/30 bg-accent/10",
  planning: "text-accent border-accent/30 bg-accent/10",
  assigned: "text-accent border-accent/30 bg-accent/10",
  ready: "text-accent border-accent/30 bg-accent/10",
  blocked: "text-warn border-warn/30 bg-warn/10",
  completed_with_failures: "text-warn border-warn/30 bg-warn/10",
  failed: "text-bad border-bad/30 bg-bad/10",
  pending: "text-dim border-line bg-raised/40",
};

const PULSING = new Set(["running", "planning", "assigned"]);

export const Badge = ({ status, className }: { status: string; className?: string }) => (
  <span className={cn(
    "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
    STATUS_TONE[status] ?? "text-dim border-line bg-raised/40", className,
  )}>
    <span className={cn("size-1.5 rounded-full bg-current", PULSING.has(status) && "animate-pulse")} />
    {status.replace(/_/g, " ")}
  </span>
);

export const ROLE_TONE: Record<string, string> = {
  frontend: "text-sky-300 bg-sky-400/10 border-sky-400/25",
  backend: "text-violet-300 bg-violet-400/10 border-violet-400/25",
  database: "text-amber-300 bg-amber-400/10 border-amber-400/25",
  testing: "text-emerald-300 bg-emerald-400/10 border-emerald-400/25",
  infra: "text-orange-300 bg-orange-400/10 border-orange-400/25",
  docs: "text-pink-300 bg-pink-400/10 border-pink-400/25",
  generalist: "text-slate-300 bg-slate-400/10 border-slate-400/25",
  master: "text-accent bg-accent/10 border-accent/25",
};

export const RoleChip = ({ role, className }: { role: string; className?: string }) => (
  <span className={cn(
    "rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
    ROLE_TONE[role] ?? ROLE_TONE.generalist, className,
  )}>
    {role}
  </span>
);

export const Spinner = ({ className }: { className?: string }) => (
  <span
    role="status"
    aria-label="loading"
    className={cn(
      "inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent",
      className,
    )}
  />
);

/** Live / reconnecting, and anything else that is on or off. */
export const Dot = ({ on, className }: { on: boolean; className?: string }) => (
  <span className={cn("relative flex size-2", className)}>
    {on && <span className="absolute inline-flex size-full animate-ping rounded-full bg-ok/60" />}
    <span className={cn("relative inline-flex size-2 rounded-full", on ? "bg-ok" : "bg-bad")} />
  </span>
);

export const Stat = ({ label, value }: { label: string; value: ReactNode }) => (
  <div>
    <p className="font-mono text-lg leading-none text-bright tabular-nums">{value}</p>
    <p className="mt-1 text-[11px] uppercase tracking-wider text-dim">{label}</p>
  </div>
);

// ---------------------------------------------------------------------- tabs

export function Tabs<T extends string>({ value, onChange, tabs, className }: {
  value: T;
  onChange: (next: T) => void;
  tabs: ReadonlyArray<{ id: T; label: string; count?: number }>;
  className?: string;
}) {
  return (
    <div role="tablist" className={cn("flex gap-1 rounded-lg border border-line/60 bg-well/50 p-1", className)}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            "flex-1 cursor-pointer rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
            value === tab.id ? "bg-raised text-bright" : "text-dim hover:text-muted",
          )}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className="ml-1.5 font-mono text-[10px] text-dim">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** An inline explanation the user can act on: a warning, or a refusal with a link. */
export const Notice = ({ tone = "warn", children }: {
  tone?: "warn" | "bad" | "accent"; children: ReactNode;
}) => (
  <div className={cn(
    "rounded-lg border px-3.5 py-2.5 text-sm",
    tone === "bad" && "border-bad/30 bg-bad/10 text-bad",
    tone === "warn" && "border-warn/30 bg-warn/10 text-warn",
    tone === "accent" && "border-accent/30 bg-accent/10 text-accent",
  )}>
    {children}
  </div>
);
