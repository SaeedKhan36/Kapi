/**
 * Verifies build artefacts can never reach a commit.
 * Agents commit with `git add -A`, so one `npm install` would otherwise put
 * thousands of node_modules files into a pull request.
 */
import { LocalProvider, cloneRepo } from "../packages/sandbox/src/index.ts";
import { commitAll, changedFiles, currentCommit } from "../packages/agent-engine/src/index.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra ? "  | " + extra : ""}`);
  if (!cond) fail++;
};

const provider = new LocalProvider();

const run = async () => {
  // A local origin, so the test needs no network.
  const box = await provider.create({ name: "hygiene" });
  await provider.exec(box.id, `
    mkdir -p origin && cd origin && git init -q --bare
  `);
  await provider.exec(box.id, `
    mkdir -p seed && cd seed && git init -q && git config user.email a@b.c && git config user.name t &&
    echo '# seed' > README.md && git add -A && git commit -qm init &&
    git remote add origin ../origin && git push -q origin HEAD:main
  `);

  await cloneRepo(provider, box.id, { repoUrl: `${box.workdir}/origin`, branch: "main", dir: "repo", depth: 0 });

  const base = await currentCommit(provider, box.id, "repo");

  // Simulate what an agent does: write source, then npm install.
  await provider.writeFile(box.id, "repo/src/App.tsx", "export default () => <p>Hello World</p>;\n");
  await provider.writeFile(box.id, "repo/package.json", '{"name":"x"}\n');
  await provider.exec(box.id, `
    cd repo &&
    mkdir -p node_modules/react dist .venv __pycache__ &&
    echo junk > node_modules/react/index.js &&
    echo junk > node_modules/.package-lock.json &&
    echo built > dist/bundle.js &&
    echo cache > __pycache__/x.pyc &&
    echo log > debug.log
  `);

  await commitAll(provider, box.id, "repo", "scaffold app");
  const changed = await changedFiles(provider, box.id, "repo", base);
  const paths = changed.map((f) => f.path);

  check("source files committed", paths.includes("src/App.tsx") && paths.includes("package.json"),
    paths.join(", "));
  check("node_modules excluded", !paths.some((p) => p.startsWith("node_modules")), paths.filter(p=>p.startsWith("node_modules")).join(", "));
  check("dist excluded", !paths.some((p) => p.startsWith("dist")));
  check("__pycache__ excluded", !paths.some((p) => p.includes("__pycache__")));
  check("logs excluded", !paths.some((p) => p.endsWith(".log")));
  check("commit stays small", paths.length <= 3, `${paths.length} files: ${paths.join(", ")}`);

  await provider.destroy(box.id);
  console.log(fail === 0 ? "\n\x1b[32mALL PASS\x1b[0m" : `\n\x1b[31m${fail} FAILURE(S)\x1b[0m`);
  process.exit(fail === 0 ? 0 : 1);
};
run().catch((e) => { console.error(e); process.exit(1); });
