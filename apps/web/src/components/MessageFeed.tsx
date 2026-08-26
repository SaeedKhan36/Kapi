import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import type { Message } from "~/lib/types.ts";
import { cn } from "~/lib/cn.ts";
import { Card, Tabs } from "./ui.tsx";

/**
 * What the agents said to each other.
 *
 * The feed defaults to decisions rather than everything, because a run emits
 * far more `LOG` than it does meaning, and a wall of log lines is the fastest
 * way to make a live view unreadable. The logs are one click away.
 */
const TYPE_TONE: Record<string, string> = {
  TASK_COMPLETED: "text-ok",
  REVIEW_APPROVED: "text-ok",
  API_READY: "text-ok",
  SCHEMA_READY: "text-ok",
  CODE_REVIEW_REQUESTED: "text-accent",
  PLAN_READY: "text-accent",
  TASK_ASSIGNED: "text-accent",
  TASK_STARTED: "text-accent",
  PLAN_REVISED: "text-warn",
  QUERY: "text-warn",
  QUERY_RESPONSE: "text-warn",
  NEEDS_HELP: "text-warn",
  BLOCKED: "text-warn",
  TASK_FAILED: "text-bad",
  TEST_FAILED: "text-bad",
  CHANGE_REQUESTED: "text-bad",
  LOG: "text-dim",
};

const shortAgent = (id: string) => id.replace(/^worker:/, "");

export function MessageFeed({ messages }: { messages: Message[] }) {
  const [filter, setFilter] = useState<"signal" | "all">("signal");
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const visible = useMemo(
    () => (filter === "all" ? messages : messages.filter((m) => m.type !== "LOG")),
    [messages, filter],
  );

  // Follow the tail, but stop fighting the user the moment they scroll up.
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3 border-b border-line/40 px-3 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-dim">Activity</h2>
        <Tabs
          className="ml-auto w-44"
          value={filter}
          onChange={setFilter}
          tabs={[
            { id: "signal", label: "Decisions" },
            { id: "all", label: "All", count: messages.length },
          ]}
        />
      </div>

      <div
        ref={ref}
        onScroll={onScroll}
        className="max-h-[64vh] min-h-[18rem] divide-y divide-line/25 overflow-y-auto"
      >
        {visible.length === 0 && (
          <div className="grid place-items-center gap-2 py-16 text-center">
            <MessageSquare className="size-5 text-dim" />
            <p className="text-sm text-dim">
              {messages.length === 0 ? "Nothing yet — the master is thinking." : "No decisions yet."}
            </p>
          </div>
        )}
        {visible.map((m) => <Row key={m.id} message={m} />)}
      </div>
    </Card>
  );
}

function Row({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const long = message.content.length > 260;
  const isLog = message.type === "LOG";

  return (
    <article className="px-3.5 py-2.5 transition-colors hover:bg-raised/25">
      <div className="flex items-center gap-1.5 font-mono text-[10px]">
        <span className="text-muted">{shortAgent(message.from)}</span>
        <span className="text-dim">→</span>
        <span className="text-dim">{shortAgent(message.to)}</span>
        <span className={cn("ml-auto font-medium", TYPE_TONE[message.type] ?? "text-dim")}>
          {message.type.replace(/_/g, " ").toLowerCase()}
        </span>
      </div>

      <p className={cn(
        "mt-1 whitespace-pre-wrap break-words",
        isLog ? "font-mono text-[11px] leading-relaxed text-dim" : "text-xs leading-relaxed text-muted",
        long && !open && "line-clamp-3",
      )}>
        {message.content}
      </p>

      {long && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="mt-1 cursor-pointer text-[10px] font-medium text-accent/80 transition-colors hover:text-accent"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}

      {message.files && message.files.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {message.files.slice(0, 8).map((f) => (
            <span
              key={f.path}
              className="rounded border border-line/50 bg-well/60 px-1.5 py-0.5 font-mono text-[10px] text-dim"
            >
              {f.path}
            </span>
          ))}
          {message.files.length > 8 && (
            <span className="px-1 py-0.5 text-[10px] text-dim">+{message.files.length - 8}</span>
          )}
        </div>
      )}
    </article>
  );
}
