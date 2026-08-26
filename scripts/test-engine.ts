/**
 * Verifies the coding loop executes batched actions correctly, against a
 * scripted LLM. No network, no quota.
 */
import { DirectEngine } from "../packages/agent-engine/src/engines/direct.ts";
import { LocalProvider } from "../packages/sandbox/src/index.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra ? "  | " + extra : ""}`);
  if (!cond) fail++;
};

/** Replays a fixed sequence of batches, recording the prompts it was given. */
class ScriptedLLM {
  readonly name = "scripted";
  calls = 0;
  promptSizes: number[] = [];
  constructor(private script: unknown[]) {}
  isAvailable() { return true; }
  modelFor() { return "scripted"; }
  async generate(): Promise<any> { throw new Error("unused"); }
  async generateStructured(messages: any[], schema: any) {
    this.promptSizes.push(JSON.stringify(messages).length);
    const value = schema.parse(this.script[Math.min(this.calls, this.script.length - 1)]);
    this.calls++;
    return { value, usage: { inputTokens: 1, outputTokens: 1, requests: 1 }, model: "scripted", provider: "scripted" };
  }
}

const provider = new LocalProvider();

const run = async () => {
  const box = await provider.create({ name: "engine-test" });
  await provider.exec(box.id, "mkdir -p repo && cd repo && git init -q && git config user.email a@b.c && git config user.name t && echo seed > seed.txt && git add -A && git commit -qm seed");

  // One batch writes three files and runs a command; the next finishes.
  const llm = new ScriptedLLM([
    { actions: [
      { tool: "write_file", path: "package.json", content: '{"name":"x"}' },
      { tool: "write_file", path: "src/App.tsx", content: "export default () => <p>Hello World</p>;" },
      { tool: "write_file", path: "index.html", content: "<!doctype html><div id=root></div>" },
      { tool: "run_command", command: "ls -1" },
    ] },
    { actions: [{ tool: "finish", summary: "scaffolded the app" }] },
  ]);

  const engine = new DirectEngine(llm as any, { maxIterations: 6 });
  const result = await engine.runTask(
    { provider, sandboxId: box.id, cwd: "repo" },
    { taskId: "t1", title: "Scaffold", instruction: "make it", contract: "none", acceptance: [], touches: [] },
  );

  check("4 actions ran in ONE request", llm.calls === 2, `${llm.calls} requests for 5 actions`);
  check("task reported complete", result.ok, result.summary);
  check("all three files created", result.filesChanged.length >= 3,
    result.filesChanged.map((f) => f.path).join(", "));
  check("work was committed", result.commits.length === 1, result.commits.join(" | "));
  check("summary came from finish", result.summary === "scaffolded the app", result.summary);

  const written = await provider.readFile(box.id, "repo/src/App.tsx");
  check("nested file written correctly", written.includes("Hello World"));

  // Context must stay bounded as turns accumulate.
  const growth = llm.promptSizes[1] / llm.promptSizes[0];
  check("prompt does not explode between requests", growth < 12, `grew ${growth.toFixed(1)}x`);

  await provider.destroy(box.id);
  console.log(fail === 0 ? "\n\x1b[32mALL PASS\x1b[0m" : `\n\x1b[31m${fail} FAILURE(S)\x1b[0m`);
  process.exit(fail === 0 ? 0 : 1);
};
run().catch((e) => { console.error(e); process.exit(1); });
