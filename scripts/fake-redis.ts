import { createServer, type Socket } from "node:net";

/**
 * Just enough Redis to test the bus against.
 *
 * The bus is the one component whose failure is invisible - a message that
 * never crosses between instances looks like a teammate who stopped replying -
 * so it should not ship on config tests alone. Docker is not available
 * everywhere and a real server is a heavy dependency for one test, but RESP
 * pub/sub is a small protocol: length-prefixed arrays in, three verbs out.
 *
 * Deliberately not a Redis implementation. It speaks PING, INFO, SUBSCRIBE,
 * UNSUBSCRIBE and PUBLISH, and answers anything else with OK.
 */
export type FakeRedis = {
  url: string;
  /** Connections currently open, so a test can assert the bus connected. */
  clients: () => number;
  close: () => Promise<void>;
};

type Client = { socket: Socket; channels: Set<string> };

const bulk = (s: string) => `$${Buffer.byteLength(s)}\r\n${s}\r\n`;

/** Splits a RESP command array off the front of a buffer, if one is complete. */
function takeCommand(buffer: string): { args: string[]; rest: string } | null {
  if (!buffer.startsWith("*")) return null;
  const lines = buffer.split("\r\n");
  const count = Number(lines[0].slice(1));
  if (!Number.isFinite(count)) return null;

  const args: string[] = [];
  let line = 1;
  for (let i = 0; i < count; i++) {
    if (lines[line] === undefined || lines[line + 1] === undefined) return null;
    args.push(lines[line + 1]);
    line += 2;
  }
  const consumed = lines.slice(0, line).join("\r\n").length + 2;
  return { args, rest: buffer.slice(consumed) };
}

export async function startFakeRedis(): Promise<FakeRedis> {
  const clients = new Set<Client>();

  const server = createServer((socket) => {
    const client: Client = { socket, channels: new Set() };
    clients.add(client);
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let taken = takeCommand(buffer); taken; taken = takeCommand(buffer)) {
        buffer = taken.rest;
        handle(client, taken.args, clients);
      }
    });

    const drop = () => { clients.delete(client); socket.destroy(); };
    socket.on("close", drop);
    socket.on("error", drop);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `redis://127.0.0.1:${port}`,
    clients: () => clients.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of clients) c.socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function handle(client: Client, args: string[], all: Set<Client>) {
  const verb = (args[0] ?? "").toUpperCase();
  if (process.env.FAKE_REDIS_DEBUG) console.log(`  [fake-redis] ${args.join(" ").slice(0, 60)}`);

  switch (verb) {
    // RESP3 changes pub/sub delivery from arrays to push frames. Refusing the
    // handshake keeps the client on RESP2, which is all this speaks.
    case "HELLO":
      client.socket.write("-ERR unknown command 'HELLO'\r\n");
      return;

    case "PING":
      client.socket.write("+PONG\r\n");
      return;

    case "INFO":
      // ioredis's ready check parses this and refuses to proceed while
      // loading:1, so the flag matters even though the rest does not.
      client.socket.write(bulk("# Server\r\nredis_version:7.0.0\r\nrole:master\r\n# Persistence\r\nloading:0\r\n"));
      return;

    case "SUBSCRIBE":
      for (const channel of args.slice(1)) {
        client.channels.add(channel);
        client.socket.write(
          `*3\r\n${bulk("subscribe")}${bulk(channel)}:${client.channels.size}\r\n`,
        );
      }
      return;

    case "UNSUBSCRIBE":
      for (const channel of args.slice(1)) {
        client.channels.delete(channel);
        client.socket.write(
          `*3\r\n${bulk("unsubscribe")}${bulk(channel)}:${client.channels.size}\r\n`,
        );
      }
      return;

    case "PUBLISH": {
      const [, channel, payload] = args;
      let delivered = 0;
      for (const other of all) {
        if (!other.channels.has(channel)) continue;
        other.socket.write(`*3\r\n${bulk("message")}${bulk(channel)}${bulk(payload)}`);
        delivered++;
      }
      client.socket.write(`:${delivered}\r\n`);
      return;
    }

    case "QUIT":
      client.socket.write("+OK\r\n");
      client.socket.end();
      return;

    default:
      // COMMAND, CLIENT SETINFO, and whatever else ioredis sends on connect.
      client.socket.write("+OK\r\n");
  }
}
