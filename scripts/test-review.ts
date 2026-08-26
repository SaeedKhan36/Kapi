/**
 * Verifies review decisions and the revision loop against a scripted LLM.
 * No network, no quota.
 */
import { normaliseVerdict, renderChangeRequest, blockingFindings, type ReviewVerdict } from "../packages/protocol/src/index.ts";
import { reviewChange } from "../packages/agent-runtime/src/reviewer.ts";
import { runWorkerTask } from "../apps/orchestrator/src/worker-runner.ts";
import { LocalProvider } from "../packages/sandbox/src/index.ts";
import { InProcessBus, AgentChannel } from "../packages/bus/src/index.ts";
import type { CodingEngine, CodingResult } from "../packages/agent-engine/src/index.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra ? "  | " + extra : ""}`);
  if (!cond) fail++;
};

const task = {
  id: "add-health", title: "Add /health endpoint", instruction: "add a health endpoint",
  role: "backend" as const, dependsOn: [], touches: ["src/server.ts"],
  acceptance: ["GET /health returns 200", "response is JSON"],
};

console.log("\n\x1b[1mverdict normalisation\x1b[0m\n");

// The findings are the evidence; a stated decision that contradicts them is wrong.
const approveWithBlocker: ReviewVerdict = {
  decision: "approve", summary: "looks fine",
  findings: [{ severity: "blocker", issue: "endpoint missing", suggestion: "add it" }],
  acceptanceMet: [false, false],
};
check("approve + blocker becomes request_changes",
  normaliseVerdict(approveWithBlocker).decision === "request_changes");

const changesWithOnlyNits: ReviewVerdict = {
  decision: "request_changes", summary: "style",
  findings: [{ severity: "nit", issue: "prefer const" }, { severity: "minor", issue: "name it better" }],
  acceptanceMet: [true, true],
};
check("request_changes with only nits becomes approve",
  normaliseVerdict(changesWithOnlyNits).decision === "approve");
check("nits are not blocking", blockingFindings(changesWithOnlyNits).length === 0);
check("majors are blocking",
  blockingFindings({ ...changesWithOnlyNits, findings: [{ severity: "major", issue: "x" }] }).length === 1);

const rendered = renderChangeRequest(approveWithBlocker);
check("change request names the fix", rendered.includes("add it") && rendered.includes("endpoint missing"));
check("change request forbids new work", rendered.includes("Do not start new work"));

console.log("\n\x1b[1mempty diff\x1b[0m\n");
const emptyLlm = { generateStructured: async () => { throw new Error("should not be called"); } } as any;
const emptyVerdict = await reviewChange(emptyLlm, {
  task, contract: "none", diff: "   \n", filesChanged: [], workerSummary: "did it",
});
check("empty diff rejected without an LLM call", emptyVerdict.decision === "request_changes");
check("empty diff marks acceptance unmet", emptyVerdict.acceptanceMet.every((m) => m === false));

console.log("\n\x1b[1mrevision loop\x1b[0m\n");

/** Fails the first attempt, succeeds after the change request. */
class RevisingEngine implements CodingEngine {
  readonly name = "revising";
  attempts: string[] = [];
  async ensureInstalled() {}
  async runTask(_ctx: any, t: any): Promise<CodingResult> {
    this.attempts.push(t.instruction);
    return {
      ok: true, incomplete: false,
      filesChanged: [{ path: "src/server.ts", action: "modified" as const }],
      commits: [`c${this.attempts.length} ${t.title}`],
      summary: `attempt ${this.attempts.length}`, log: "",
    };
  }
}

const provider = new LocalProvider();
const bus = new InProcessBus();

const runOnce = async (verdicts: ReviewVerdict[], maxReviewRounds = 1) => {
  const engine = new RevisingEngine();
  const channel = new AgentChannel(bus, "r1", "worker:backend", 200);
  const seen: string[] = [];
  const observer = new AgentChannel(bus, "r1", "master", 200);
  observer.onMessage((m) => seen.push(m.type));

  let merges = 0;
  let i = 0;
  const outcome = await runWorkerTask(
    {
      runId: "r1", repoUrl: "unused", baseBranch: "main", githubToken: "fake",
      provider, engine, contract: "none",
      identity: { name: "t", email: "t@t" }, idleTtlSeconds: 60,
      maxReviewRounds,
      review: async () => verdicts[Math.min(i++, verdicts.length - 1)],
      mergeBack: async () => { merges++; return { ok: true, conflicted: false, detail: "" }; },
    } as any,
    task, channel,
  );
  await Promise.all([channel.close(), observer.close()]);
  return { outcome, engine, merges, seen };
};

// Stub git/network so the scheduler logic is what is under test.
const realExec = LocalProvider.prototype.exec;
LocalProvider.prototype.exec = async function (id: string, cmd: string, opts?: any) {
  if (/^git |^rm -rf/.test(cmd.trim())) return { exitCode: 0, stdout: "abc123", stderr: "", durationMs: 0 };
  return realExec.call(this, id, cmd, opts);
} as any;

const approved: ReviewVerdict = { decision: "approve", summary: "good", findings: [], acceptanceMet: [true, true] };
const rejected: ReviewVerdict = {
  decision: "request_changes", summary: "endpoint returns text, not JSON",
  findings: [{ severity: "blocker", file: "src/server.ts", issue: "returns text/plain", suggestion: "return JSON" }],
  acceptanceMet: [true, false],
};

const a = await runOnce([approved]);
check("approved work merges", a.merges === 1 && a.outcome.merged, `merges=${a.merges}`);
check("approved work is ok", a.outcome.ok);
check("no revision when approved", a.engine.attempts.length === 1, `${a.engine.attempts.length} attempts`);
check("REVIEW_APPROVED emitted", a.seen.includes("REVIEW_APPROVED"), a.seen.join(","));

const b = await runOnce([rejected, approved]);
check("change request triggers exactly one revision", b.engine.attempts.length === 2,
  `${b.engine.attempts.length} attempts`);
check("revision instruction carries the finding",
  b.engine.attempts[1].includes("returns text/plain") && b.engine.attempts[1].includes("return JSON"));
check("revised-then-approved work merges", b.merges === 1 && b.outcome.merged);
check("CHANGE_REQUESTED emitted", b.seen.includes("CHANGE_REQUESTED"), b.seen.join(","));
check("reviewRounds counted", b.outcome.reviewRounds === 2, String(b.outcome.reviewRounds));

const c = await runOnce([rejected, rejected]);
check("persistently rejected work does NOT merge", c.merges === 0 && !c.outcome.merged, `merges=${c.merges}`);
check("persistently rejected work is not ok", !c.outcome.ok);
check("revision rounds are bounded", c.engine.attempts.length === 2, `${c.engine.attempts.length} attempts`);
check("branch still pushed for a human", c.outcome.pushed);
check("TASK_FAILED emitted", c.seen.includes("TASK_FAILED"), c.seen.join(","));

const d = await runOnce([rejected, rejected, approved], 2);
check("extra rounds allowed when configured", d.engine.attempts.length === 3, `${d.engine.attempts.length} attempts`);
check("approval on the last round still merges", d.merges === 1);

LocalProvider.prototype.exec = realExec;
await bus.close();
await provider.destroyAll();

console.log(fail === 0 ? "\n\x1b[32mALL PASS\x1b[0m\n" : `\n\x1b[31m${fail} FAILURE(S)\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
