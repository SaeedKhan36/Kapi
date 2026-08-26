/**
 * Serves the built dashboard.
 *
 * `vite build` emits a Web `fetch` handler, not a listening server - TanStack
 * Start leaves the choice of host open, so Vercel, Cloudflare and Node each
 * bring their own adapter. This is the Node one: static assets off disk, and
 * everything else handed to the handler for server-side rendering.
 *
 * Written by hand rather than pulled from a preset because the whole runtime
 * need is thirty lines, and a preset would drag in a deployment opinion kapi
 * does not have.
 */
import { connect } from "node:net";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const clientDir = join(root, "dist/client");
const { default: handler } = await import(join(root, "dist/server/server.js"));

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

/**
 * Where the orchestrator lives.
 *
 * In development Vite proxies /api and /ws so the browser stays same-origin;
 * production needs the same thing or the dashboard cannot reach its API at
 * all. Doing it here keeps the alternative - absolute URLs plus CORS plus a
 * second origin to configure - off the table.
 */
const orchestrator = new URL(process.env.ORCHESTRATOR_URL ?? "http://localhost:8787");
const isApi = (pathname) => pathname === "/ws" || pathname.startsWith("/api/");

const MIME = {
  ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".ico": "image/x-icon", ".webp": "image/webp", ".woff": "font/woff",
  ".woff2": "font/woff2", ".txt": "text/plain", ".map": "application/json",
};

/** Resolves a URL path to a file inside dist/client, or null. */
function staticFile(pathname) {
  // normalize collapses `..`; the prefix check then keeps the result inside
  // clientDir, so a crafted path cannot read the rest of the filesystem.
  const candidate = normalize(join(clientDir, decodeURIComponent(pathname)));
  if (!candidate.startsWith(clientDir)) return null;
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return null;
  return candidate;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (isApi(url.pathname)) {
      await proxy(req, res, url);
      return;
    }

    const file = staticFile(url.pathname);
    if (file) {
      // Hashed asset filenames change whenever the content does, so they are
      // safe to cache indefinitely; anything else must be revalidated.
      const immutable = url.pathname.startsWith("/assets/");
      res.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
      });
      createReadStream(file).pipe(res);
      return;
    }

    const body = req.method === "GET" || req.method === "HEAD"
      ? undefined
      : await new Promise((resolve) => {
          const chunks = [];
          req.on("data", (c) => chunks.push(c));
          req.on("end", () => resolve(Buffer.concat(chunks)));
        });

    const response = await handler.fetch(
      new Request(url, { method: req.method, headers: req.headers, body, duplex: "half" }),
    );

    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      const reader = response.body.getReader();
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        res.write(chunk.value);
      }
    }
    res.end();
  } catch (err) {
    console.error("[web] request failed:", err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("Internal Server Error");
  }
});

/** Forwards an /api request to the orchestrator and streams the reply back. */
async function proxy(req, res, url) {
  const target = new URL(url.pathname + url.search, orchestrator);
  const body = req.method === "GET" || req.method === "HEAD"
    ? undefined
    : await new Promise((resolve) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
      });

  // `host` must not be forwarded: it still names this server, and the
  // orchestrator would build redirect URLs pointing back at the wrong origin.
  const headers = { ...req.headers };
  delete headers.host;

  try {
    const upstream = await fetch(target, { method: req.method, headers, body, redirect: "manual", duplex: "half" });
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    if (upstream.body) {
      const reader = upstream.body.getReader();
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) res.write(chunk.value);
    }
    res.end();
  } catch (err) {
    console.error("[web] orchestrator unreachable:", err instanceof Error ? err.message : err);
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "the orchestrator is unreachable" }));
  }
}

/**
 * Pipes a WebSocket upgrade through to the orchestrator.
 *
 * Raw sockets rather than a library: an upgrade is just the original request
 * replayed upstream and then two streams glued together, and the live run feed
 * is the one thing the dashboard cannot work without.
 */
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (!isApi(url.pathname)) {
    socket.destroy();
    return;
  }

  const upstream = connect(
    Number(orchestrator.port || 80),
    orchestrator.hostname,
    () => {
      const headers = Object.entries(req.headers)
        .filter(([k]) => k !== "host")
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\nhost: ${orchestrator.host}\r\n${headers.join("\r\n")}\r\n\r\n`,
      );
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    },
  );

  const drop = () => { socket.destroy(); upstream.destroy(); };
  upstream.on("error", drop);
  socket.on("error", drop);
});

server.listen(port, host, () =>
  console.log(`\n  kapi dashboard  http://localhost:${port}\n  api proxied to  ${orchestrator.origin}\n`));

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
