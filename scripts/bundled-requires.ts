/**
 * Packages that third-party code inside the bundle reaches through `require()`.
 *
 * esbuild inlines what it can see. A static `import` is visible; a call like
 * `require(name)` through a captured binding is not, so the module stays a bare
 * specifier that Node resolves at runtime - relative to `dist/orchestrator.mjs`,
 * which is the wrong place to look. `dist/` has no node_modules, and the
 * sibling `/app/node_modules` is pnpm's isolated layout: it holds only the
 * root's direct dependencies, so a transitive one like `form-data` lives at
 * `.pnpm/form-data@4.0.6/node_modules/form-data` and is invisible from `dist/`.
 * Shipping node_modules does not fix this; the `hosted` image ships it and the
 * lookup still failed.
 *
 * So each such package is imported statically here - which puts a real copy in
 * the bundle - and registered under the name its consumer asks for. The
 * `require` shim in scripts/build.ts checks this table first.
 *
 * The Daytona SDK is the only consumer today, and it needs one module per
 * direction of a file transfer - both loaded lazily, so neither surfaced at
 * startup:
 *
 *   form-data  writeFile -> fs.uploadFile, which builds the multipart request
 *   busboy     readFile  -> fs.downloadFile, which parses the multipart reply
 *
 * Fixing only the upload just moves the failure one call later: readFile is the
 * very next thing an agent does. Add both, and prefer adding a module here over
 * discovering it in production - the SDK reaches for `tar`, `fast-glob`,
 * `expand-tilde` and `@iarna/toml` on paths kapi does not use today.
 */
import FormData from "form-data";
import busboy from "busboy";

const BUNDLED: Record<string, unknown> = {
  "form-data": FormData,
  busboy,
};

// Read by the banner's `require`, which is defined before this module runs and
// resolves the table per call - so registration order does not matter.
(globalThis as Record<string, unknown>).__kapiBundledRequires = BUNDLED;

export { BUNDLED };
