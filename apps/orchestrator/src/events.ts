import type { RunEvent } from "./run-engine.ts";

type Client = {
  runId: string | null;
  /** Whose feed this is. Undefined only in single-operator mode. */
  userId: string | undefined;
  send: (data: string) => void;
};

/**
 * Fan-out of run events to connected browsers.
 *
 * Kept separate from the MessageBus: the bus is the agents' transport, this is
 * the UI's. Conflating them would let a browser inject agent traffic.
 *
 * Every run event names a run, and a run has an owner, so fan-out is filtered
 * by both. Subscribing without a runId is a legitimate "show me my dashboard"
 * request, not a request for everyone's - which is what it used to deliver.
 */
export class EventHub {
  #clients = new Set<Client>();
  #recent = new Map<string, RunEvent[]>();
  #owner = new Map<string, string | undefined>();

  /**
   * Records who a run belongs to, so its events can be routed.
   *
   * A run nobody registered has no owner and is therefore visible only to an
   * unscoped listener, which exists only when authentication is off. Failing
   * closed matters more here than showing a stray event.
   */
  register(runId: string, userId: string | undefined) {
    this.#owner.set(runId, userId);
  }

  #visibleTo(runId: string, client: Client): boolean {
    if (client.runId !== null && client.runId !== runId) return false;
    if (client.userId === undefined) return true;
    return this.#owner.get(runId) === client.userId;
  }

  add(client: Client) {
    this.#clients.add(client);
    // Replay so a browser joining mid-run is not staring at an empty screen.
    if (client.runId && this.#visibleTo(client.runId, client)) {
      for (const e of this.#recent.get(client.runId) ?? []) {
        client.send(JSON.stringify(e));
      }
    }
    return () => this.#clients.delete(client);
  }

  publish(event: RunEvent) {
    const runId = "runId" in event ? event.runId : event.message.runId;
    const buffer = this.#recent.get(runId) ?? [];
    buffer.push(event);
    if (buffer.length > 500) buffer.shift();
    this.#recent.set(runId, buffer);

    const payload = JSON.stringify(event);
    for (const client of this.#clients) {
      if (!this.#visibleTo(runId, client)) continue;
      try { client.send(payload); } catch { this.#clients.delete(client); }
    }
  }

  get clientCount() { return this.#clients.size; }
}
