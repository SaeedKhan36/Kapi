import { Link } from "@tanstack/react-router";
import {
  Boxes, ChevronDown, Cpu, GitBranch, Layers, MessageSquare, Network,
  Radio, ShieldCheck, Workflow,
} from "lucide-react";
import type { ReactNode } from "react";
import { buttonClass, Card, RoleChip } from "../ui.tsx";
import { GithubMark, Logo } from "../Logo.tsx";
import { HeaderAuthActions } from "../auth.tsx";
import { RunPreview } from "./RunPreview.tsx";
import { Architecture } from "./Architecture.tsx";

const REPO = "https://github.com/SaeedKhan36/kapi";

const NAV = [
  { href: "#how", label: "How it works" },
  { href: "#capabilities", label: "Capabilities" },
  { href: "#architecture", label: "Architecture" },
  { href: "#pricing", label: "What it costs" },
] as const;

// --------------------------------------------------------------------- chrome

export function MarketingNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-line/40 bg-ink/80 backdrop-blur-xl">
      <div className="shell flex h-16 items-center gap-8">
        <Link to="/" aria-label="kapi home"><Logo /></Link>

        <nav className="hidden gap-6 md:flex">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="text-sm text-muted transition-colors hover:text-bright"
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <a
            href={REPO}
            target="_blank"
            rel="noreferrer"
            aria-label="kapi on GitHub"
            className="hidden text-dim transition-colors hover:text-bright sm:block"
          >
            <GithubMark className="size-[18px]" />
          </a>
          <HeaderAuthActions />
        </div>
      </div>
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className="border-t border-line/40 py-10">
      <div className="shell flex flex-col items-center justify-between gap-4 sm:flex-row">
        <Logo />
        <p className="text-xs text-dim">
          Free and open source. Inspired by capy.ai, built to run on free tiers.
        </p>
        <a
          href={REPO}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 text-xs text-dim transition-colors hover:text-bright"
        >
          <GithubMark className="size-3.5" /> Source
        </a>
      </div>
    </footer>
  );
}

// ----------------------------------------------------------------------- hero

export function Hero() {
  return (
    <section className="shell grid items-center gap-14 py-16 lg:grid-cols-[1.15fr_1fr] lg:py-24">
      <div>
        <span className="inline-flex items-center gap-2 rounded-full border border-line/60 bg-surface/60 px-3 py-1 text-xs text-muted">
          <span className="size-1.5 rounded-full bg-ok" />
          Open source · runs entirely on free tiers
        </span>

        <h1 className="mt-6 text-balance text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl lg:text-[3rem]">
          Your AI engineering team,<br />
          <span className="text-gradient">working in parallel.</span>
        </h1>

        <p className="mt-5 max-w-lg text-lg leading-relaxed text-muted">
          Describe a feature. A master agent turns it into a task graph, then a
          specialist worker builds each piece — its own sandbox, its own git
          branch, all coordinating as they go.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link to="/app" className={buttonClass("primary", "lg")}>
            Start a run
          </Link>
          <a href="#how" className={buttonClass("secondary", "lg")}>
            See how it works
          </a>
        </div>

        <p className="mt-5 text-xs text-dim">
          No credit card · your repository stays yours · one API key to start
        </p>
      </div>

      <RunPreview />
    </section>
  );
}

export function StatStrip() {
  const stats = [
    { value: "7", label: "specialist roles" },
    { value: "1", label: "sandbox per worker" },
    { value: "∞", label: "parallel waves" },
    { value: "$0", label: "to run it" },
  ];
  return (
    <div className="shell">
      <div className="reveal grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-card)] border border-line/50 bg-line/40 sm:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="bg-ink/60 px-5 py-6 text-center">
            <p className="text-3xl font-semibold tracking-tight text-bright">{stat.value}</p>
            <p className="mt-1 text-xs uppercase tracking-wider text-dim">{stat.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- how it works

const STEPS = [
  {
    icon: Workflow,
    title: "Plan",
    body: "The master clones your repo read-only and emits a task graph: a shared contract plus tasks with dependencies.",
  },
  {
    icon: Layers,
    title: "Schedule",
    body: "The orchestrator walks the graph and starts every task whose dependencies are finished — in waves, not a queue.",
  },
  {
    icon: Cpu,
    title: "Implement",
    body: "Each worker gets a fresh sandbox and a clone on its own branch, and talks to the others as interfaces land.",
  },
  {
    icon: GitBranch,
    title: "Report",
    body: "Commits land on worker branches and are pushed to your repository. You review and merge, as always.",
  },
] as const;

export function HowItWorks() {
  return (
    <Band id="how" eyebrow="How a run works" title="One goal in, four stages out">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {STEPS.map((step, i) => (
          <Card key={step.title} className="reveal p-5" style={{ transitionDelay: `${i * 60}ms` }}>
            <div className="flex items-center justify-between">
              <span className="grid size-9 place-items-center rounded-lg border border-accent/25 bg-accent/10 text-accent">
                <step.icon className="size-4" />
              </span>
              <span className="font-mono text-xs text-dim">0{i + 1}</span>
            </div>
            <h3 className="mt-4 font-semibold text-bright">{step.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">{step.body}</p>
          </Card>
        ))}
      </div>
    </Band>
  );
}

// --------------------------------------------------------------- capabilities

const FEATURES: ReadonlyArray<{
  icon: typeof Network; title: string; body: string; span: string;
}> = [
  {
    icon: Network,
    title: "A dependency graph, not a to-do list",
    body: "Tasks declare what they depend on, so the scheduler knows exactly what can run at the same time.",
    span: "lg:col-span-3",
  },
  {
    icon: Boxes,
    title: "Real isolation",
    body: "Local, Docker, or a cloud sandbox — one per worker, torn down when it goes idle.",
    span: "lg:col-span-3",
  },
  {
    icon: MessageSquare,
    title: "Agents that talk",
    body: "Typed messages over a bus: SCHEMA_READY, API_READY, CHANGE_REQUESTED.",
    span: "lg:col-span-2",
  },
  {
    icon: GitBranch,
    title: "Git-native output",
    body: "Ordinary commits on ordinary branches. Nothing to import, nothing to trust blindly.",
    span: "lg:col-span-2",
  },
  {
    icon: ShieldCheck,
    title: "Scoped credentials",
    body: "A sandbox gets a token for one repository, for an hour. Never your own.",
    span: "lg:col-span-2",
  },
  {
    icon: Radio,
    title: "Watch it happen",
    body: "The dashboard streams the same events the audit log stores — no polling, no refresh.",
    span: "lg:col-span-6",
  },
];

export function Capabilities() {
  return (
    <Band
      id="capabilities"
      eyebrow="Capabilities"
      title="Built like infrastructure, not a demo"
    >
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-6">
        {FEATURES.map((feature, i) => (
          <Card
            key={feature.title}
            className={`reveal p-5 transition-colors hover:border-accent/40 ${feature.span}`}
            style={{ transitionDelay: `${i * 50}ms` }}
          >
            <feature.icon className="size-5 text-accent" />
            <h3 className="mt-4 font-semibold text-bright">{feature.title}</h3>
            <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted">{feature.body}</p>
          </Card>
        ))}
      </div>
    </Band>
  );
}

export function ArchitectureSection() {
  return (
    <Band
      id="architecture"
      eyebrow="Architecture"
      title="Three moving parts"
      lead="Every capability sits behind an interface with more than one implementation, so no vendor is load-bearing."
    >
      <div className="reveal"><Architecture /></div>
    </Band>
  );
}

// --------------------------------------------------------------------- pricing

const KEYS = [
  { name: "Gemini", need: "required", what: "The model the agents think with", where: "aistudio.google.com" },
  { name: "GitHub", need: "to push", what: "A fine-grained token, or the kapi app", where: "github.com" },
  { name: "Clerk", need: "to share", what: "Sign-in, if more than you will use it", where: "clerk.com" },
  { name: "Neon", need: "optional", what: "Postgres — otherwise it runs embedded", where: "neon.tech" },
  { name: "Daytona", need: "optional", what: "Cloud sandboxes instead of local ones", where: "daytona.io" },
  { name: "Upstash", need: "optional", what: "Redis bus for multiple instances", where: "upstash.com" },
] as const;

export function Pricing() {
  return (
    <Band
      id="pricing"
      eyebrow="What it costs"
      title="Nothing, and it stays that way"
      lead="kapi is designed around free tiers. One key gets you running; everything else is opt-in."
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {KEYS.map((key, i) => (
          <Card key={key.name} className="reveal p-4" style={{ transitionDelay: `${i * 40}ms` }}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-medium text-bright">{key.name}</h3>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                key.need === "required"
                  ? "border-accent/30 bg-accent/10 text-accent"
                  : "border-line/60 text-dim"
              }`}>
                {key.need}
              </span>
            </div>
            <p className="mt-1.5 text-sm text-muted">{key.what}</p>
            <p className="mt-2 font-mono text-[11px] text-dim">{key.where}</p>
          </Card>
        ))}
      </div>
    </Band>
  );
}

// ------------------------------------------------------------------------ faq

const FAQ = [
  {
    q: "Does it push straight to my main branch?",
    a: "No. Every worker commits on its own branch, named after the run and the task. Merging is yours to do, in the normal way.",
  },
  {
    q: "What can an agent actually reach?",
    a: "One sandbox, one clone, and a token scoped to that single repository for an hour. Your own GitHub credential never leaves the orchestrator.",
  },
  {
    q: "What happens when a task fails?",
    a: "It goes back to the master, which can revise the plan, re-dispatch the work, or redistribute it to another role. Attempts are visible on the task.",
  },
  {
    q: "Do I need a database?",
    a: "Not to start. With no DATABASE_URL, kapi runs embedded Postgres in .kapi/db and creates its tables on first run.",
  },
  {
    q: "Can I run it without signing in?",
    a: "Yes. With no Clerk keys configured kapi stays single-operator: no login screen, one credential, exactly as the CLI works.",
  },
] as const;

export function Faq() {
  return (
    <Band eyebrow="Questions" title="Before you start">
      <div className="mx-auto max-w-3xl divide-y divide-line/40 overflow-hidden rounded-[var(--radius-card)] border border-line/50 bg-surface/40">
        {FAQ.map((item) => (
          <details key={item.q} className="group px-5">
            <summary className="flex cursor-pointer items-center justify-between gap-4 py-4 text-left text-sm font-medium text-bright">
              {item.q}
              <ChevronDown className="size-4 shrink-0 text-dim transition-transform duration-200 group-open:rotate-180" />
            </summary>
            <p className="pb-4 pr-8 text-sm leading-relaxed text-muted">{item.a}</p>
          </details>
        ))}
      </div>
    </Band>
  );
}

// ------------------------------------------------------------------------ cta

export function CallToAction() {
  return (
    <section className="shell py-20">
      <div className="reveal relative overflow-hidden rounded-2xl border border-line/60 bg-surface/50 px-6 py-14 text-center">
        <div
          aria-hidden
          className="absolute inset-x-0 -top-24 h-48 bg-gradient-to-b from-accent/20 to-transparent blur-2xl"
        />
        <div className="relative">
          <div className="mb-6 flex flex-wrap justify-center gap-1.5">
            {["frontend", "backend", "database", "testing"].map((role) => (
              <RoleChip key={role} role={role} />
            ))}
          </div>
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Give the team its first goal
          </h2>
          <p className="mx-auto mt-3 max-w-md text-muted">
            Sign in, point kapi at a repository, and watch the plan come back.
          </p>
          <Link to="/app" className={`${buttonClass("primary", "lg")} mt-8`}>
            Open the dashboard
          </Link>
        </div>
      </div>
    </section>
  );
}

// --------------------------------------------------------------------- layout

/** One vertical rhythm for every section, so the page reads as a single column. */
function Band({ id, eyebrow, title, lead, children }: {
  id?: string; eyebrow: string; title: string; lead?: string; children: ReactNode;
}) {
  return (
    <section id={id} className="shell scroll-mt-20 py-16 lg:py-20">
      <div className="reveal mb-8 max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">{eyebrow}</p>
        <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-[2.1rem]">{title}</h2>
        {lead && <p className="mt-3 text-[15px] leading-relaxed text-muted">{lead}</p>}
      </div>
      {children}
    </section>
  );
}
