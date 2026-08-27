/**
 * Bundles the orchestrator into one file that plain `node` can run.
 *
 * Production must not depend on tsx. It is a development loader: it compiles
 * on every start, and shipping it means shipping a TypeScript toolchain into
 * the runtime image. Bundling instead gives a single artifact, a fast start,
 * and a container that needs nothing but Node.
 *
 * Workspace sources are bundled because they are TypeScript - `@kapi/db`
 * resolves through a pnpm symlink to a `.ts` file that Node cannot load on its
 * own. Everything in EXTERNAL stays outside the bundle and is expected in
 * node_modules at runtime.
 */
import { build, type BuildOptions } from "esbuild";
import { pathToFileURL } from "node:url";

/**
 * Everything is bundled except genuinely optional drivers.
 *
 * The obvious alternative - leave npm packages out and ship node_modules - does
 * not survive pnpm's isolated layout: `@electric-sql/pglite` is a dependency of
 * `@kapi/db`, so it lives under `packages/db/node_modules` and is unresolvable
 * from a bundle sitting in `dist/`. Rather than flatten the workspace to suit
 * the bundler, everything goes in and the runtime image needs no node_modules.
 *
 * The exceptions are drivers that cannot or should not be inlined:
 *
 *   PGlite loads a WebAssembly filesystem image from beside its own source, so
 *   a bundled copy looks for `postgres.data` next to this artifact and fails.
 *   ESM links statically, which means the mere presence of drizzle's pglite
 *   driver would break startup even for deployments that never touch it - so
 *   the driver is external too. The built artifact therefore requires a real
 *   DATABASE_URL, which is what a deployment should have anyway: PGlite is
 *   single-writer and would not survive a second container.
 *
 * Each is reached through a dynamic import, so an absent one surfaces as a
 * runtime error on the path that needs it rather than a failure to start.
 *
 * ioredis is deliberately NOT excluded: a multi-instance deployment needs the
 * Redis bus, and an image that cannot provide it would be a worse default than
 * the megabyte it costs.
 */
const EXTERNAL = ["@electric-sql/pglite", "drizzle-orm/pglite"];

/**
 * Everything about the bundle except what goes into it.
 *
 * Exported so a test can build a probe with the real settings rather than a
 * copy that drifts: the `inject` and `banner` below are load-bearing, and a
 * test asserting against its own reconstruction of them would pass while
 * production broke.
 */
export const BUNDLE_OPTIONS = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: EXTERNAL,
  // Pulls the packages that bundled third-party code require()s at runtime into
  // the bundle. See scripts/bundled-requires.ts for why they need the help.
  inject: ["scripts/bundled-requires.ts"],
  minify: false, // A readable stack trace is worth more than the kilobytes.
  // esbuild emits ESM that references these; Node provides them for CJS only.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      "const __nodeRequire = __createRequire(import.meta.url);",
      // Bundled packages first, then the filesystem. Object.assign keeps
      // require.resolve and friends, which callers reasonably expect to exist.
      "const require = Object.assign(",
      "  (id) => globalThis.__kapiBundledRequires?.[id] ?? __nodeRequire(id),",
      "  __nodeRequire,",
      ");",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);",
    ].join("\n"),
  },
} as const satisfies BuildOptions;

/**
 * The migrator ships alongside the server.
 *
 * A release needs to apply migrations before the new code starts, and the
 * runtime image has no pnpm, no TypeScript and no node_modules. Bundling it
 * too means `node dist/migrate.mjs` is a complete release step.
 */
export const buildBundles = () =>
  build({
    ...BUNDLE_OPTIONS,
    entryPoints: {
      orchestrator: "apps/orchestrator/src/index.ts",
      migrate: "scripts/migrate.ts",
    },
    outdir: "dist",
    outExtension: { ".js": ".mjs" },
    sourcemap: true,
    logLevel: "info",
  });

// Importing this module for BUNDLE_OPTIONS must not also produce a build.
const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const result = await buildBundles();
  if (result.errors.length > 0) process.exit(1);
  console.log([
    "",
    "  dist/orchestrator.mjs   node dist/orchestrator.mjs",
    "  dist/migrate.mjs        node dist/migrate.mjs --status",
    "",
  ].join("\n"));
}
