import { randomBytes } from "node:crypto";

export type WsTicketClaims = {
  userId: string;
  runId: string | null;
  expiresAt: number;
};

/**
 * Short-lived tickets for the live feed.
 *
 * Browsers cannot set headers on a WebSocket, so the upgrade has to carry
 * proof in the query string. Putting the session JWT there writes it into
 * reverse-proxy access logs. A ticket is a random handle that maps to the
 * already-verified user for two minutes; reconnects mint a fresh one.
 */
export class WsTicketStore {
  #tickets = new Map<string, WsTicketClaims>();

  constructor(readonly ttlMs = 120_000) {}

  issue(userId: string, runId: string | null = null, now = Date.now()): {
    ticket: string;
    expiresInSeconds: number;
  } {
    this.#prune(now);
    const ticket = randomBytes(24).toString("base64url");
    this.#tickets.set(ticket, { userId, runId, expiresAt: now + this.ttlMs });
    return { ticket, expiresInSeconds: Math.ceil(this.ttlMs / 1000) };
  }

  resolve(ticket: string | undefined, now = Date.now()): WsTicketClaims | undefined {
    if (!ticket) return undefined;
    const claims = this.#tickets.get(ticket);
    if (!claims || claims.expiresAt <= now) {
      this.#tickets.delete(ticket);
      return undefined;
    }
    return claims;
  }

  get size() {
    return this.#tickets.size;
  }

  #prune(now: number) {
    for (const [key, claims] of this.#tickets) {
      if (claims.expiresAt <= now) this.#tickets.delete(key);
    }
  }
}
