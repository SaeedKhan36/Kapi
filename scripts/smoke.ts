/**
 * M1 gate: proves the sandbox and LLM abstractions actually work end to end.
 *   pnpm smoke                    # auto-detect best provider
 *   pnpm smoke --provider=local   # force one
 */
import { loadEnv } from "../packages/env/src/index.ts";
loadEnv();

import { createSandboxProvider, detectBestProvider, cloneRepo, integrationBranch, type SandboxProvider } from "../packages/sandbox/src/index.ts";
import { createLLM } from "../packages/llm/src/index.ts";
import { createDb, describeDbTarget } from "../packages/db/src/index.ts";

const arg = process.argv.find((a) => a.startsWith("--provider="))?.split("=")[1];
// Free-tier quota is per model per day, so make it easy to exercise the
// sandbox and database paths without spending any of it.
const skipLlm = process.argv.includes("--skip-llm");
const REPO = process.env.SMOKE_REPO ?? "https://github.com/octocat/Hello-World.git";

let pass = 0;
let fail = 0;
const step = async (name: string, fn: () => Promise<string | void>) => {
  const t = Date.now();
  try {
    const detail = await fn();
    console.log(`  \x1b[32mok\x1b[0m    ${name} \x1b[2m(${Date.now() - t}ms)${detail ? " " + detail : ""}\x1b[0m`);
    pass++;
  } catch (err) {
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        ${err instanceof Error ? err.message : String(err)}`);
    fail++;
  }
};

const main = async () => {
  console.log("\n\x1b[1mkapi smoke test\x1b[0m\n");

  const provider: SandboxProvider = arg ? createSandboxProvider(arg as any) : await detectBestProvider();
  console.log(`  provider: \x1b[36m${provider.name}\x1b[0m`);
  console.log(`  database: \x1b[36m${describeDbTarget()}\x1b[0m\n`);

  console.log("\x1b[1m sandbox\x1b[0m");
  let sandboxId = "";

  await step("create sandbox", async () => {
    const box = await provider.create({
      name: "smoke",
      env: { KAPI_SMOKE: "1" },
      idleTtlSeconds: 300,
      cpus: 1,
      memoryMb: 2048,
    });
    sandboxId = box.id;
    return `workdir=${box.workdir}`;
  });

  if (!sandboxId) {
    console.log("\n\x1b[31msandbox creation failed - aborting\x1b[0m\n");
    process.exit(1);
  }

  try {
    await step("exec command", async () => {
      const res = await provider.exec(sandboxId, "echo hello-from-sandbox && uname -s");
      if (res.exitCode !== 0) throw new Error(`exit ${res.exitCode}: ${res.stderr}`);
      if (!res.stdout.includes("hello-from-sandbox")) throw new Error(`unexpected stdout: ${res.stdout}`);
      return res.stdout.trim().split("\n").pop();
    });

    await step("exec reports non-zero exit", async () => {
      const res = await provider.exec(sandboxId, "exit 3");
      if (res.exitCode !== 3) throw new Error(`expected exit 3, got ${res.exitCode}`);
    });

    await step("env vars reach the sandbox", async () => {
      const res = await provider.exec(sandboxId, "echo $KAPI_SMOKE");
      if (res.stdout.trim() !== "1") throw new Error(`expected "1", got "${res.stdout.trim()}"`);
    });

    await step("write + read file round-trip", async () => {
      const content = `line one\n"quotes" 'single' $VAR \`tick\`\nunicode ✓\n`;
      await provider.writeFile(sandboxId, "nested/dir/test.txt", content);
      const back = await provider.readFile(sandboxId, "nested/dir/test.txt");
      if (back !== content) throw new Error(`round-trip mismatch:\n  wrote ${JSON.stringify(content)}\n  read  ${JSON.stringify(back)}`);
    });

    await step("streaming exec yields chunks", async () => {
      let out = "";
      for await (const chunk of provider.execStream(sandboxId, "for i in 1 2 3; do echo chunk-$i; done")) {
        out += chunk.data;
      }
      if (!out.includes("chunk-3")) throw new Error(`missing output: ${out}`);
      return `${out.trim().split("\n").length} lines`;
    });

    await step("git clone into sandbox", async () => {
      await cloneRepo(provider, sandboxId, { repoUrl: REPO, depth: 1, dir: "repo" });
      const res = await provider.exec(sandboxId, "git log --oneline -1", { cwd: "repo" });
      if (res.exitCode !== 0) throw new Error(`git log failed: ${res.stderr}`);
      return res.stdout.trim();
    });

    await step("git identity configured", async () => {
      const res = await provider.exec(sandboxId, "git config user.name", { cwd: "repo" });
      if (!res.stdout.trim()) throw new Error("user.name not set");
      return res.stdout.trim();
    });

    if (provider.name === "local") {
      await step("path escape is rejected", async () => {
        try {
          await provider.readFile(sandboxId, "../../../../etc/passwd");
          throw new Error("expected escape to be rejected");
        } catch (err) {
          if (err instanceof Error && err.message.includes("escapes sandbox")) return "blocked";
          throw err;
        }
      });
    }
  } finally {
    await step("destroy sandbox", async () => {
      await provider.destroy(sandboxId);
    });
  }

  console.log("\n\x1b[1m database\x1b[0m");
  await step("connect + write + read", async () => {
    const db = await createDb();
    const { runs } = await import("../packages/db/src/schema.ts");
    const id = `smoke-${Date.now().toString(36)}`;
    await db.insert(runs).values({
      id, goal: "smoke", repoUrl: REPO, integrationBranch: integrationBranch(id), sandboxProvider: provider.name,
    });
    const rows = await db.select().from(runs);
    if (!rows.some((r) => r.id === id)) throw new Error("inserted run not found");
    return `${rows.length} run(s) in db`;
  });

  console.log("\n\x1b[1m llm\x1b[0m");
  const llm = createLLM();
  if (skipLlm) {
    console.log("  \x1b[33mskip\x1b[0m  --skip-llm set (preserving daily quota)");
  } else if (!llm.isAvailable()) {
    console.log("  \x1b[33mskip\x1b[0m  no LLM key set - add GEMINI_API_KEY to .env (free, no card)");
  } else {
    console.log(`  chain: \x1b[36m${llm.available.map((p) => p.name).join(" -> ")}\x1b[0m`);
    await step("generate text", async () => {
      const res = await llm.generate([{ role: "user", content: "Reply with exactly: PONG" }], { tier: "cheap", maxOutputTokens: 32 });
      if (!res.text.toUpperCase().includes("PONG")) throw new Error(`unexpected: ${res.text}`);
      return `${res.provider}/${res.model}`;
    });

    await step("structured output validates", async () => {
      const { z } = await import("zod");
      const schema = z.object({ language: z.string(), year: z.number().int() });
      const res = await llm.generateStructured(
        [{ role: "user", content: "In which year was the TypeScript language first released? Return {language, year}." }],
        schema,
        { tier: "cheap" },
      );
      if (res.value.year !== 2012) throw new Error(`expected 2012, got ${res.value.year}`);
      return JSON.stringify(res.value);
    });

    const u = llm.usage();
    console.log(`  \x1b[2mbudget: ${u.requests}/${u.maxRequests} requests, ${u.totalTokens}/${u.maxTokens} tokens\x1b[0m`);
  }

  console.log(`\n${fail === 0 ? "\x1b[32mALL PASS" : "\x1b[31m" + fail + " FAILED"}\x1b[0m  (${pass} passed)\n`);
  process.exit(fail === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error("\n\x1b[31mfatal:\x1b[0m", err);
  process.exit(1);
});
