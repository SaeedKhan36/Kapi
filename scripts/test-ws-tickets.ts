/**
 * WebSocket tickets must identify a user without carrying their session JWT.
 */
import { WsTicketStore } from "../apps/orchestrator/src/ws-tickets.ts";

let failures = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "\x1b[32mok  \x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${extra ? `  | ${extra}` : ""}`);
  if (!cond) failures++;
};

console.log("\n\x1b[1mws tickets\x1b[0m\n");

{
  const store = new WsTicketStore(1_000);
  const { ticket, expiresInSeconds } = store.issue("user-1", "run-9");
  check("issues an opaque handle", ticket.length >= 20 && !ticket.includes("user-1"));
  check("ttl is advertised in seconds", expiresInSeconds === 1);

  const claims = store.resolve(ticket);
  check("resolves to the issuing user", claims?.userId === "user-1");
  check("binds the run id", claims?.runId === "run-9");
  check("does not consume on resolve (reconnects reuse it)", store.resolve(ticket)?.userId === "user-1");
}

{
  const store = new WsTicketStore(50);
  const { ticket } = store.issue("user-1", null, 0);
  check("expired tickets are gone", store.resolve(ticket, 51) === undefined);
  check("unknown tickets are gone", store.resolve("nope") === undefined);
}

console.log(failures === 0 ? "\n\x1b[32mALL PASS\x1b[0m\n" : `\n\x1b[31m${failures} FAILED\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
