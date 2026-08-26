import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Plain JavaScript on purpose.
 *
 * drizzle-kit transpiles a .ts config with its own bundled esbuild, which is
 * older than the toolchain here and rejects the repository's `ES2023` target.
 * The config is six lines of data, so removing the transpile step is cheaper
 * than pinning a second tsconfig just to satisfy a build tool.
 *
 * @type {import("drizzle-kit").Config}
 */
const envFile = resolve(process.cwd(), ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default {
  schema: "./packages/db/src/schema.ts",
  out: "./packages/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
};
