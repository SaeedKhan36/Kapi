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
import { build } from "esbuild";

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
 *   ioredis is not installed at all. The Redis bus reaches it through a
 *   dynamic import so a deployment on the in-process bus never needs it.
 *
 * Each is reached through a dynamic import, so an absent one surfaces as a
 * runtime error on the path that needs it rather than a failure to start.
 */
const EXTERNAL = ["@electric-sql/pglite", "drizzle-orm/pglite", "ioredis"];

/**
 * The migrator ships alongside the server.
 *
 * A release needs to apply migrations before the new code starts, and the
 * runtime image has no pnpm, no TypeScript and no node_modules. Bundling it
 * too means `node dist/migrate.mjs` is a complete release step.
 */
const result = await build({
  entryPoints: {
    orchestrator: "apps/orchestrator/src/index.ts",
    migrate: "scripts/migrate.ts",
  },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: EXTERNAL,
  sourcemap: true,
  minify: false, // A readable stack trace is worth more than the kilobytes.
  logLevel: "info",
  // esbuild emits ESM that references these; Node provides them for CJS only.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);",
    ].join("\n"),
  },
});

if (result.errors.length > 0) process.exit(1);
console.log([
  "",
  "  dist/orchestrator.mjs   node dist/orchestrator.mjs",
  "  dist/migrate.mjs        node dist/migrate.mjs --status",
  "",
].join("\n"));
