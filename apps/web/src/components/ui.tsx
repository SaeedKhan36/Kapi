import type {
  ButtonHTMLAttributes, ComponentProps, HTMLAttributes, ReactNode,
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
      "rounded-[var(--radius-card)] border-[1.5px] border-line bg-surface shadow-[4px_4px_0_#1c1917]",
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
  <Card className="grid place-items-center gap-2 bg-[#fff8e7] px-6 py-12 text-center">
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
  primary:
    "border-[1.5px] border-line bg-[#bae6fd] text-bright hover:bg-[#7dd3fc] hover:shadow-[3px_3px_0_#1c1917] hover:-translate-y-px active:translate-y-0 active:shadow-none",
  secondary:
    "border-[1.5px] border-line bg-[#fef08a] text-bright hover:bg-[#fde047] hover:shadow-[3px_3px_0_#1c1917] hover:-translate-y-px",
  ghost: "text-muted hover:bg-raised hover:text-bright",
} as const;

const BUTTON_SIZE = {
  sm: "h-8 px-3 text-xs gap-1.5 rounded-full",
  md: "h-10 px-4 text-sm gap-2 rounded-full",
  lg: "h-12 px-6 text-[0.95rem] gap-2 rounded-full",
} as const;

export const Button = ({ className, variant = "primary", size = "md", ...props }: ButtonProps) => (
  <button
    className={cn(
      "inline-flex cursor-pointer items-center justify-center font-semibold",
      "transition-[background-color,border-color,box-shadow,transform] duration-200",
      "disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none disabled:translate-y-0",
      BUTTON_VARIANT[variant], BUTTON_SIZE[size], className,
    )}
    {...props}
  />
);

/** The same surface as Button, for links. Anchors cannot be buttons. */
export const buttonClass = (variant: keyof typeof BUTTON_VARIANT = "primary", size: keyof typeof BUTTON_SIZE = "md") =>
  cn(
    "inline-flex cursor-pointer items-center justify-center font-semibold transition-all duration-200",
    BUTTON_VARIANT[variant], BUTTON_SIZE[size],
  );

const FIELD_SURFACE =
  "w-full rounded-xl border-[1.5px] border-line bg-well px-3 py-2 text-sm text-bright transition-colors " +
  "placeholder:text-dim/80 hover:bg-white focus:border-line focus:bg-white focus:outline-none focus:shadow-[3px_3px_0_#1c1917]";

export const Input = ({ className, ...props }: ComponentProps<"input">) => (
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
      <span className="text-sm font-semibold text-bright">{label}</span>
      {hint && <span className="text-xs text-dim">{hint}</span>}
    </span>
    <div className="mt-2">{children}</div>
  </label>
);

// -------------------------------------------------------------------- status

const STATUS_TONE: Record<string, string> = {
  review: "text-bright border-line bg-[#bbf7d0]",
  merged: "text-bright border-line bg-[#bbf7d0]",
  completed: "text-bright border-line bg-[#bbf7d0]",
  running: "text-bright border-line bg-[#bae6fd]",
  planning: "text-bright border-line bg-[#e9d5ff]",
  assigned: "text-bright border-line bg-[#bae6fd]",
  ready: "text-bright border-line bg-[#dbeafe]",
  blocked: "text-bright border-line bg-[#fef08a]",
  completed_with_failures: "text-bright border-line bg-[#fef08a]",
  failed: "text-bright border-line bg-[#fecaca]",
  pending: "text-muted border-line bg-white",
};

const PULSING = new Set(["running", "planning", "assigned"]);

export const Badge = ({ status, className }: { status: string; className?: string }) => (
  <span className={cn(
    "inline-flex shrink-0 items-center gap-1.5 rounded-full border-[1.5px] px-2.5 py-0.5 text-[11px] font-semibold",
    STATUS_TONE[status] ?? "text-muted border-line bg-white", className,
  )}>
    <span className={cn("size-1.5 rounded-full bg-current", PULSING.has(status) && "animate-pulse")} />
    {status.replace(/_/g, " ")}
  </span>
);

export const ROLE_TONE: Record<string, string> = {
  frontend: "text-bright bg-[#bae6fd] border-line",
  backend: "text-bright bg-[#e9d5ff] border-line",
  database: "text-bright bg-[#fef08a] border-line",
  testing: "text-bright bg-[#bbf7d0] border-line",
  infra: "text-bright bg-[#fed7aa] border-line",
  docs: "text-bright bg-[#fbcfe8] border-line",
  generalist: "text-bright bg-white border-line",
  master: "text-bright bg-[#c4b5fd] border-line",
};

export const RoleChip = ({ role, className }: { role: string; className?: string }) => (
  <span className={cn(
    "rounded-full border-[1.5px] px-2 py-0.5 text-[11px] font-semibold",
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
    {on && <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#86efac]" />}
    <span className={cn("relative inline-flex size-2 rounded-full", on ? "bg-[#22c55e]" : "bg-[#ef4444]")} />
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
    <div role="tablist" className={cn(
      "flex gap-1 rounded-full border-[1.5px] border-line bg-white p-1 shadow-[3px_3px_0_#1c1917]",
      className,
    )}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            "flex-1 cursor-pointer rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
            value === tab.id ? "bg-[#bae6fd] text-bright" : "text-dim hover:text-bright",
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
    "rounded-2xl border-[1.5px] border-line px-3.5 py-2.5 text-sm shadow-[3px_3px_0_#1c1917]",
    tone === "bad" && "bg-[#fecaca] text-bright",
    tone === "warn" && "bg-[#fef08a] text-bright",
    tone === "accent" && "bg-[#bae6fd] text-bright",
  )}>
    {children}
  </div>
);
