/**
 * The bundle must carry the packages that bundled code require()s at runtime.
 *
 * `writeFile` on the Daytona provider uploads through the SDK, which loads
 * `form-data` lazily via require(). esbuild cannot see that call, so the
 * specifier survived into `dist/orchestrator.mjs` and Node resolved it from
 * `dist/` - where pnpm's isolated layout hides it, transitive dependencies
 * living under `.pnpm/` rather than beside the bundle. Every run on Render
 * failed on the first file an agent wrote:
 *
 *   Uploading files is not supported: Module "form-data" is not available in
 *   the "node" runtime: Cannot find module 'form-data'
 *
 * Nothing caught it because the bundle builds, starts and serves fine; only the
 * upload path touches the missing module. So this builds a probe with the real
 * BUNDLE_OPTIONS and runs it somewhere no node_modules is reachable, which is
 * what the runtime image looks like.
 */
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_OPTIONS } from "./build.ts";
import { BUNDLED } from "./bundled-requires.ts";

const run = promisify(execFile);

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "\x1b[32mok  \x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${extra ? `  | ${extra}` : ""}`);
  if (!cond) failures++;
};

/**
 * Mirrors what the Daytona SDK does with the module it requires: unwrap an
 * interop default, then check the shape. A module that resolves but arrives as
 * `{ default: fn }` fails the SDK's `typeof mod === 'function'` test and
 * produces the same user-visible error as one that is missing outright.
 */
const PROBE = `
const unwrap = (m) => (m && m.__esModule && m.default !== undefined ? m.default : m);
const out = {};
for (const id of ${JSON.stringify(Object.keys(BUNDLED))}) {
  try {
    const mod = unwrap(require(id));
    out[id] = { resolved: true, isFunction: typeof mod === "function" };
    if (id === "form-data") {
      const form = new mod();
      form.append("files[0].path", "/tmp/x.txt");
      form.append("files[0].file", Buffer.from("hello"), { filename: "/tmp/x.txt" });
      out[id].multipart = typeof form.getHeaders()["content-type"] === "string";
    }
  } catch (err) {
    out[id] = { resolved: false, error: String(err && err.message) };
  }
}
console.log("__PROBE__" + JSON.stringify(out));
`;

const main = async () => {
  console.log("\n\x1b[1mbundled runtime requires\x1b[0m\n");

  const ids = Object.keys(BUNDLED);
  check("at least one package is registered", ids.length > 0, ids.join(", "));

  // Outside the repo, so nothing up the directory tree can satisfy a require
  // the bundle was supposed to satisfy itself.
  const dir = await mkdtemp(join(tmpdir(), "kapi-bundle-"));
  try {
    const entry = join(dir, "probe.ts");
    const out = join(dir, "probe.mjs");
    await writeFile(entry, PROBE);

    const built = await build({
      ...BUNDLE_OPTIONS,
      // BUNDLE_OPTIONS holds a repo-relative inject path; esbuild resolves it
      // against cwd, which stays the repo root here.
      entryPoints: [entry],
      outfile: out,
      logLevel: "silent",
    });
    check("probe bundles with the production settings", built.errors.length === 0,
      built.errors.map((e) => e.text).join("; ") || "clean");

    const { stdout } = await run(process.execPath, [out], { cwd: dir });
    const line = stdout.split("\n").find((l) => l.startsWith("__PROBE__"));
    check("probe ran", !!line, line ? "" : stdout.trim());
    if (!line) return;

    const results = JSON.parse(line.slice("__PROBE__".length));
    for (const id of ids) {
      const r = results[id];
      check(`require("${id}") resolves with no node_modules in reach`, r?.resolved === true, r?.error ?? "");
      check(`require("${id}") returns the shape its consumer expects`, r?.isFunction === true);
    }
    check("form-data builds a multipart body", results["form-data"]?.multipart === true,
      "the Daytona upload path constructs one per file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

await main();
console.log(failures === 0 ? "\n\x1b[32mall good\x1b[0m\n" : `\n\x1b[31m${failures} failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
