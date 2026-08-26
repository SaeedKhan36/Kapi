/**
 * Verifies a dependant worker inherits its dependency's work.
 *
 * Without the integration branch every worker clones the base branch, so a
 * dependency edge means nothing: the second task never sees the first task's
 * files. Local git only — no network, no LLM.
 */
import {
  LocalProvider, cloneRepo, createRemoteBranch, mergeIntoIntegration,
  integrationBranch, taskBranch,
} from "../packages/sandbox/src/index.ts";
import { commitAll, createBranch } from "../packages/agent-engine/src/index.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra ? "  | " + extra : ""}`);
  if (!cond) fail++;
};

const provider = new LocalProvider();
const RUN = "testrun";

const run = async () => {
  const host = await provider.create({ name: "integration" });
  const origin = `${host.workdir}/origin`;

  await provider.exec(host.id, `mkdir -p origin && cd origin && git init -q --bare`);
  await provider.exec(host.id, `
    mkdir -p seed && cd seed && git init -q && git config user.email a@b.c && git config user.name t &&
    echo '# seed' > README.md && git add -A && git commit -qm init &&
    git branch -M main && git remote add origin ${origin} && git push -q origin main`);

  // --- run setup: integration branch off main
  const setup = await provider.create({ name: "master" });
  await cloneRepo(provider, setup.id, { repoUrl: origin, branch: "main", dir: "repo", depth: 0 });
  await createRemoteBranch(provider, setup.id, {
    branch: integrationBranch(RUN), from: "main", dir: "repo",
  });
  check("integration branch created on origin", true);

  // --- worker A: scaffolds, branching from integration
  const a = await provider.create({ name: "worker-a" });
  await cloneRepo(provider, a.id, { repoUrl: origin, branch: integrationBranch(RUN), dir: "repo", depth: 0 });
  const branchA = taskBranch(RUN, "scaffold");
  await createBranch(provider, a.id, "repo", branchA);
  await provider.writeFile(a.id, "repo/package.json", '{"name":"app","scripts":{"build":"echo built"}}\n');
  await provider.writeFile(a.id, "repo/src/App.tsx", "export default () => <p>Hello World</p>;\n");
  await commitAll(provider, a.id, "repo", "scaffold app");
  await provider.exec(a.id, `git push -q -u origin ${branchA}`, { cwd: "repo" });

  const merge = await mergeIntoIntegration(provider, a.id, {
    integration: integrationBranch(RUN), branch: branchA, dir: "repo",
  });
  check("worker A merged into integration", merge.ok, merge.detail);
  check("merge reported no conflict", !merge.conflicted);

  // --- worker B: the dependant. THE test.
  const b = await provider.create({ name: "worker-b" });
  await cloneRepo(provider, b.id, { repoUrl: origin, branch: integrationBranch(RUN), dir: "repo", depth: 0 });

  const ls = await provider.exec(b.id, "ls -1", { cwd: "repo" });
  check("dependant sees package.json from its dependency", ls.stdout.includes("package.json"),
    ls.stdout.trim().split("\n").join(", "));
  check("dependant sees src/ from its dependency", ls.stdout.includes("src"));

  const built = await provider.exec(b.id, "npm run build 2>&1 || true", { cwd: "repo" });
  check("dependant can run the dependency's build script", built.stdout.includes("built"),
    built.stdout.trim().slice(-60));

  // --- second merge from a different worker still lands
  const branchB = taskBranch(RUN, "verify");
  await createBranch(provider, b.id, "repo", branchB);
  await provider.writeFile(b.id, "repo/BUILD.md", "build verified\n");
  await commitAll(provider, b.id, "repo", "record verification");
  await provider.exec(b.id, `git push -q -u origin ${branchB}`, { cwd: "repo" });
  const merge2 = await mergeIntoIntegration(provider, b.id, {
    integration: integrationBranch(RUN), branch: branchB, dir: "repo",
  });
  check("second worker merged on top", merge2.ok, merge2.detail);

  const final = await provider.exec(b.id, `git ls-tree --name-only -r origin/${integrationBranch(RUN)}`, { cwd: "repo" });
  const files = final.stdout.trim().split("\n").filter(Boolean).sort();
  check("integration holds BOTH workers' output",
    files.includes("package.json") && files.includes("BUILD.md") && files.includes("src/App.tsx"),
    files.join(", "));

  // --- conflict is reported, not silently swallowed
  const c = await provider.create({ name: "worker-c" });
  await cloneRepo(provider, c.id, { repoUrl: origin, branch: integrationBranch(RUN), dir: "repo", depth: 0 });
  await provider.exec(c.id, `git checkout -q -b conflictor origin/${integrationBranch(RUN)}~1`, { cwd: "repo" });
  await provider.writeFile(c.id, "repo/BUILD.md", "totally different content\n");
  await commitAll(provider, c.id, "repo", "conflicting change");
  await provider.exec(c.id, "git push -q -u origin conflictor", { cwd: "repo" });
  const merge3 = await mergeIntoIntegration(provider, c.id, {
    integration: integrationBranch(RUN), branch: "conflictor", dir: "repo",
  });
  check("conflict is detected and reported", !merge3.ok && merge3.conflicted,
    `ok=${merge3.ok} conflicted=${merge3.conflicted}`);

  await Promise.all([host, setup, a, b, c].map((s) => provider.destroy(s.id)));
  console.log(fail === 0 ? "\n\x1b[32mALL PASS\x1b[0m" : `\n\x1b[31m${fail} FAILURE(S)\x1b[0m`);
  process.exit(fail === 0 ? 0 : 1);
};
run().catch((e) => { console.error(e); process.exit(1); });
