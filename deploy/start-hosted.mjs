/**
 * One process tree for a single public port (Render, a VM, etc.).
 *
 * The dashboard already proxies /api and /ws. This starts the orchestrator on
 * loopback, waits until it answers, then binds the dashboard to PORT.
 */
import { spawn } from "node:child_process";

if (process.env.RENDER_EXTERNAL_URL && !process.env.KAPI_PUBLIC_URL) {
  process.env.KAPI_PUBLIC_URL = process.env.RENDER_EXTERNAL_URL;
}

const root = process.cwd();
const apiPort = process.env.ORCHESTRATOR_PORT ?? "8787";
process.env.ORCHESTRATOR_URL ??= `http://127.0.0.1:${apiPort}`;
process.env.HOST ??= "0.0.0.0";
process.env.NODE_ENV ??= "production";

const children = [];

const spawnLogged = (name, args, extra = {}) => {
  const child = spawn("node", args, {
    cwd: extra.cwd ?? root,
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("exit", (code, signal) => {
    if (signal) return;
    console.error(`[hosted] ${name} exited ${code}`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
};

const wait = async (url, tries = 240) => {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* booting */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${url}`);
};

const shutdown = (code = 0) => {
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 1500).unref();
};

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const migrate = spawn("node", ["dist/migrate.mjs"], { cwd: root, env: process.env, stdio: "inherit" });
const migrateCode = await new Promise((resolve) => migrate.on("exit", resolve));
if (migrateCode !== 0) {
  console.error("[hosted] migrate failed");
  process.exit(migrateCode ?? 1);
}

spawnLogged("orchestrator", ["dist/orchestrator.mjs"]);
await wait(`http://127.0.0.1:${apiPort}/api/health`);

spawnLogged("web", ["server.mjs"], { cwd: `${root}/apps/web` });
console.log(`[hosted] dashboard on ${process.env.PORT ?? 3000}, api on ${apiPort}`);
await new Promise(() => {});
